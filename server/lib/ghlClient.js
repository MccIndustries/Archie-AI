const { AsyncLocalStorage } = require('node:async_hooks');

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

class GhlApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'GhlApiError';
    this.status = status;
    this.details = details;
  }
}

// This is a single shared deployment serving every client -- there's no one
// global GHL account. requireAuth resolves the logged-in user's client row
// and runs the rest of the request inside this store, so config() (and
// everything below that calls it) transparently gets the right tenant's
// credentials with no signature changes anywhere else in this file.
const tenantStorage = new AsyncLocalStorage();

function runWithTenant(tenant, fn) {
  return tenantStorage.run(tenant, fn);
}

// Lets other modules (e.g. supabase.js, for tagging sync_log/job_files rows)
// read the current request's tenant without needing it passed through every
// call site, and without importing requireAuth (which would be circular).
function getTenant() {
  return tenantStorage.getStore() || null;
}

function config() {
  const tenant = tenantStorage.getStore();
  if (!tenant?.apiToken || !tenant?.locationId) {
    throw new GhlApiError('This account is not connected to GHL yet.', 409);
  }
  return { token: tenant.apiToken, locationId: tenant.locationId };
}

async function request(method, path, { query, body } = {}) {
  const { token } = config();
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.message || `GHL API ${method} ${path} failed with ${res.status}`;
    throw new GhlApiError(message, res.status, data);
  }
  return data;
}

// ---------- Contacts ----------

async function listContacts({ query, limit } = {}) {
  const { locationId } = config();
  const data = await request('GET', '/contacts/', {
    query: { locationId, query, limit: limit || 50 },
  });
  return data.contacts || [];
}

function getContact(id) {
  return request('GET', `/contacts/${id}`).then((d) => d.contact);
}

async function getContactsCount() {
  const { locationId } = config();
  const data = await request('GET', '/contacts/', { query: { locationId, limit: 1 } });
  return data.meta?.total ?? (data.contacts ? data.contacts.length : 0);
}

// GHL's advanced /contacts/search endpoint has an undocumented, brittle
// filter schema (confirmed via trial against the live API: neither
// dateAdded/gte nor date_added/range worked as expected). The basic list
// endpoint is reliably sorted newest-first, so for a single shop's daily
// volume it's simpler and safer to page through it and count client-side.
async function countContactsCreatedSince(sinceISO) {
  const sinceMs = new Date(sinceISO).getTime();
  const contacts = await listContacts({ limit: 100 });
  return contacts.filter((c) => new Date(c.dateAdded).getTime() >= sinceMs).length;
}

function createContact({ firstName, lastName, email, phone, tags }) {
  const { locationId } = config();
  return request('POST', '/contacts/', {
    body: { locationId, firstName, lastName, email, phone, tags },
  }).then((d) => d.contact);
}

function updateContact(id, { firstName, lastName, email, phone }) {
  return request('PUT', `/contacts/${id}`, {
    body: { firstName, lastName, email, phone },
  }).then((d) => d.contact);
}

function deleteContact(id) {
  return request('DELETE', `/contacts/${id}`);
}

// GHL itself blocks creating a contact that duplicates an existing one by
// phone or email ("This location does not allow duplicated contacts").
// Rather than let intake hard-fail for a returning customer, attempt the
// create and recover from that specific error -- GHL's error response
// hands back the existing contact's ID directly. (A pre-emptive search
// first was tried and rejected: GHL's contacts search index lags a few
// seconds behind writes -- same eventual-consistency behavior seen
// elsewhere in this project -- so a contact created moments earlier could
// still search as "not found," defeating the whole point. The create
// endpoint's own duplicate check is immediately consistent, so recovering
// from its error is the reliable path.)
async function findOrCreateContact({ firstName, lastName, email, phone, tags }) {
  try {
    const contact = await createContact({ firstName, lastName, email, phone, tags });
    return { contact, reused: false };
  } catch (err) {
    const existingId = err instanceof GhlApiError && err.details?.meta?.contactId;
    if (existingId && /duplicat/i.test(err.message)) {
      const contact = await getContact(existingId);
      return { contact, reused: true };
    }
    throw err;
  }
}

function addTags(id, tags) {
  return request('POST', `/contacts/${id}/tags`, { body: { tags } });
}

function removeTags(id, tags) {
  return request('DELETE', `/contacts/${id}/tags`, { body: { tags } });
}

// All tags ever applied in this location -- used to populate the Contacts
// page's tag filter with real options instead of a free-text guess.
async function listTags() {
  const { locationId } = config();
  const data = await request('GET', `/locations/${locationId}/tags`);
  return (data.tags || []).map((t) => ({ id: t.id, name: t.name }));
}

// Smart-list style filtering (tag + created-date range) needs the advanced
// /contacts/search endpoint -- the basic /contacts/ list has no filter
// params of its own (confirmed live: ?tags= is rejected with 422). Two
// quirks confirmed via live testing: a multi-value "tags" filter is an OR
// match (any selected tag), and dateAdded range values must be epoch
// milliseconds -- ISO strings silently match nothing, same quirk seen with
// calendar events elsewhere in this project.
async function searchContacts({ query, tags, dateFrom, dateTo, limit } = {}) {
  const { locationId } = config();
  const filters = [];
  if (tags && tags.length) {
    filters.push({ field: 'tags', operator: 'contains', value: tags.length === 1 ? tags[0] : tags });
  }
  if (dateFrom || dateTo) {
    const value = {};
    if (dateFrom) value.gte = new Date(dateFrom).getTime();
    if (dateTo) {
      const d = new Date(dateTo);
      // A bare "YYYY-MM-DD" (e.g. from an <input type=date>) parses to
      // midnight UTC -- treat it as the END of that day, inclusive, or a
      // same-day range would exclude the entire day it names.
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) d.setUTCHours(23, 59, 59, 999);
      value.lte = d.getTime();
    }
    filters.push({ field: 'dateAdded', operator: 'range', value });
  }
  const body = { locationId, pageLimit: limit || 100 };
  if (query) body.query = query;
  if (filters.length) body.filters = filters;
  const data = await request('POST', '/contacts/search', { body });
  return { contacts: data.contacts || [], total: data.total ?? (data.contacts || []).length };
}

// ---------- Pipelines ----------
// Cached briefly in memory: pipelines/stages rarely change, and every job
// list/detail request wants stage names, not just stage IDs.

// Keyed by locationId -- a shared multi-tenant process must not let one
// tenant's cached pipelines/stages leak into another tenant's response.
const pipelinesCache = new Map(); // locationId -> { data, at }
const PIPELINES_TTL_MS = 60_000;

async function listPipelines({ fresh = false } = {}) {
  const { locationId } = config();
  const now = Date.now();
  const cached = pipelinesCache.get(locationId);
  if (!fresh && cached?.data && now - cached.at < PIPELINES_TTL_MS) {
    return cached.data;
  }
  const data = await request('GET', '/opportunities/pipelines', { query: { locationId } });
  const entry = { data: data.pipelines || [], at: now };
  pipelinesCache.set(locationId, entry);
  return entry.data;
}

async function getDefaultPipelineId() {
  const tenant = tenantStorage.getStore();
  if (tenant?.pipelineId) return tenant.pipelineId;
  const pipelines = await listPipelines();
  if (!pipelines.length) throw new GhlApiError('No pipelines found for this location', 500);
  return pipelines[0].id;
}

async function stageNameLookup() {
  const pipelines = await listPipelines();
  const map = new Map();
  for (const p of pipelines) {
    for (const s of p.stages || []) map.set(s.id, s.name);
  }
  return map;
}

// ---------- Custom Fields (car make/model/damage on the Job) ----------
// The client hasn't defined opportunity custom fields in GHL yet, so the
// portal creates them itself the first time they're needed, then reuses
// the same field IDs from then on (cached for the process lifetime).

const JOB_FIELD_DEFS = [
  { key: 'carMake', name: 'Car Make', dataType: 'TEXT' },
  { key: 'carModel', name: 'Car Model', dataType: 'TEXT' },
  { key: 'damageDescription', name: 'Damage Description', dataType: 'LARGE_TEXT' },
  { key: 'customerFirstName', name: 'Customer First Name', dataType: 'TEXT' },
  { key: 'customerLastName', name: 'Customer Last Name', dataType: 'TEXT' },
  { key: 'customerEmail', name: 'Customer Email', dataType: 'TEXT' },
  { key: 'customerPhone', name: 'Customer Phone', dataType: 'PHONE' },
];

const jobFieldsCache = new Map(); // locationId -> { carMake: id, ... }

async function ensureJobCustomFields() {
  const { locationId } = config();
  const cached = jobFieldsCache.get(locationId);
  if (cached) return cached;
  const data = await request('GET', `/locations/${locationId}/customFields`, {
    query: { model: 'opportunity' },
  });
  const existing = data.customFields || [];
  const byName = new Map(existing.map((f) => [f.name, f]));

  const ids = {};
  for (const def of JOB_FIELD_DEFS) {
    let field = byName.get(def.name);
    if (!field) {
      const created = await request('POST', `/locations/${locationId}/customFields`, {
        body: { name: def.name, dataType: def.dataType, model: 'opportunity' },
      });
      field = created.customField || created;
    }
    ids[def.key] = field.id;
  }
  jobFieldsCache.set(locationId, ids);
  return ids;
}

// All opportunity custom field *definitions* in the location (id -> name/
// dataType) -- not just the ones this portal created. A shop owner may add
// their own fields directly in GHL, and the Job Detail view should still be
// able to show them by name instead of a raw field ID.
const fieldDefsCache = new Map(); // locationId -> { data, at }
const FIELD_DEFS_TTL_MS = 60_000;

async function listOpportunityFieldDefs({ fresh = false } = {}) {
  const { locationId } = config();
  const now = Date.now();
  const cached = fieldDefsCache.get(locationId);
  if (!fresh && cached?.data && now - cached.at < FIELD_DEFS_TTL_MS) {
    return cached.data;
  }
  const data = await request('GET', `/locations/${locationId}/customFields`, {
    query: { model: 'opportunity' },
  });
  const entry = { data: data.customFields || [], at: now };
  fieldDefsCache.set(locationId, entry);
  return entry.data;
}

function buildCustomFieldsPayload(
  { carMake, carModel, damageDescription, firstName, lastName, email, phone } = {},
  fieldIds
) {
  const out = [];
  if (carMake !== undefined) out.push({ id: fieldIds.carMake, value: carMake });
  if (carModel !== undefined) out.push({ id: fieldIds.carModel, value: carModel });
  if (damageDescription !== undefined) out.push({ id: fieldIds.damageDescription, value: damageDescription });
  if (firstName !== undefined) out.push({ id: fieldIds.customerFirstName, value: firstName });
  if (lastName !== undefined) out.push({ id: fieldIds.customerLastName, value: lastName });
  if (email !== undefined) out.push({ id: fieldIds.customerEmail, value: email });
  if (phone !== undefined) out.push({ id: fieldIds.customerPhone, value: phone });
  return out.length ? out : undefined;
}

// ---------- Photo fields (one FILE_UPLOAD field per photo) ----------
// GHL's FILE_UPLOAD custom field only reliably holds ONE file per field --
// arrays/comma-joined strings are silently rejected (confirmed live: 200
// response, but the field's value doesn't actually change). So instead of
// one shared field per category, this grows a set of shared field
// *definitions* named "<Category> 1", "<Category> 2", ... on demand --
// deliberately kept separate from the fixed metadata fields above, since
// "category" is an open-ended, user-typeable concept (Photos, Insurance
// Documents, Paperwork, or any custom name), not a fixed schema.

const categoryFieldsCache = new Map(); // "locationId::category" -> ordered field ID array

async function ensureCategoryFields(category, count) {
  const { locationId } = config();
  const cacheKey = `${locationId}::${category}`;
  let ids = categoryFieldsCache.get(cacheKey) || [];
  if (ids.length < count) {
    const data = await request('GET', `/locations/${locationId}/customFields`, {
      query: { model: 'opportunity' },
    });
    const existing = data.customFields || [];
    const re = new RegExp(`^${category} (\\d+)$`);
    for (const f of existing) {
      const m = re.exec(f.name || '');
      if (m) ids[Number(m[1]) - 1] = f.id;
    }
  }
  for (let i = 0; i < count; i++) {
    if (ids[i]) continue;
    const created = await request('POST', `/locations/${locationId}/customFields`, {
      body: { name: `${category} ${i + 1}`, dataType: 'FILE_UPLOAD', model: 'opportunity' },
    });
    ids[i] = (created.customField || created).id;
  }
  categoryFieldsCache.set(cacheKey, ids);
  return ids.slice(0, count);
}

// Assigns new files to the first slot(s) that are empty *on this specific
// job* -- other jobs may already have their own values in the same shared
// field slots, which is fine since each opportunity's field values are
// independent. Grows the category if this job has used every known slot.
async function assignCategoryFiles(jobId, category, fileUrls) {
  if (!fileUrls.length) return;
  const raw = await getJobRaw(jobId);
  const usedIds = new Set(
    (raw.customFields || [])
      .filter((f) => (f.value ?? f.fieldValue ?? f.fieldValueString) != null)
      .map((f) => f.id)
  );

  let ids = await ensureCategoryFields(category, 1);
  const assignments = {};
  let cursor = 0;
  for (const url of fileUrls) {
    while (ids[cursor] && usedIds.has(ids[cursor])) cursor++;
    if (cursor >= ids.length) {
      ids = await ensureCategoryFields(category, ids.length + 1);
    }
    assignments[ids[cursor]] = url;
    usedIds.add(ids[cursor]);
    cursor++;
  }

  return updateJob(jobId, { photoFieldValues: assignments });
}

// Uses the media library's own multipart upload -- separate from the
// generic JSON `request()` helper since this is form-data, not JSON.
async function uploadMedia({ buffer, filename, contentType }) {
  const { token } = config();
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType }), filename);
  const res = await fetch(`${BASE_URL}/medias/upload-file`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Version: API_VERSION, Accept: 'application/json' },
    body: fd,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new GhlApiError(data?.message || 'Media upload failed', res.status, data);
  return data; // { fileId, url }
}

// ---------- Conversations ----------
// Creates an empty conversation shell tied to the contact -- deliberately
// does NOT send a real message, so intake never accidentally texts/emails
// a real customer.

function createConversation({ contactId }) {
  const { locationId } = config();
  return request('POST', '/conversations/', { body: { locationId, contactId } }).then(
    (d) => d.conversation || d
  );
}

// A contact can only ever have one conversation -- GHL rejects a second
// create attempt with 400 "Conversation already exists", but usefully
// includes the existing conversationId right on the error body. Same
// attempt-then-recover shape as findOrCreateContact.
async function findOrCreateConversation({ contactId }) {
  try {
    const conversation = await createConversation({ contactId });
    return { conversation, reused: false };
  } catch (err) {
    const existingId = err instanceof GhlApiError && err.details?.conversationId;
    if (existingId) {
      return { conversation: { id: existingId, contactId }, reused: true };
    }
    throw err;
  }
}

function listConversations({ limit } = {}) {
  const { locationId } = config();
  return request('GET', '/conversations/search', { query: { locationId, limit: limit || 50 } }).then(
    (d) => d.conversations || []
  );
}

function getConversationMessages(conversationId) {
  return request('GET', `/conversations/${conversationId}/messages`).then((d) => d.messages?.messages || []);
}

// GHL accepts the send request (201) even with no phone number connected --
// the created message's own `status` becomes "failed" with an explanatory
// `error` field, rather than the request itself failing. Callers should
// surface that per-message, not just the HTTP status.
function sendMessage({ contactId, message, type, fromNumber }) {
  const { locationId } = config();
  return request('POST', '/conversations/messages', {
    body: { locationId, contactId, message, type: type || 'SMS', fromNumber: fromNumber || undefined },
  });
}

// The location's connected sending numbers (LC Phone / Twilio), so the
// desk can pick which one a message goes out from.
function listPhoneNumbers() {
  const { locationId } = config();
  return request('GET', '/phone-system/numbers', { query: { locationId } }).then(
    (d) => d.phoneNumbers || []
  );
}

// ---------- Calendars ----------

function listCalendars() {
  const { locationId } = config();
  return request('GET', '/calendars/', { query: { locationId } }).then((d) => d.calendars || []);
}

// Used by the Admin portal to fetch a prospective client's calendars using
// credentials typed into the Add Client form -- there's no saved client
// (and no .env) to read config from yet, so this takes them explicitly
// instead of going through the usual config()/request() path.
async function listCalendarsFor({ apiToken, locationId }) {
  const res = await fetch(`${BASE_URL}/calendars/?locationId=${encodeURIComponent(locationId)}`, {
    headers: { Authorization: `Bearer ${apiToken}`, Version: API_VERSION, Accept: 'application/json' },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new GhlApiError(data?.message || 'Failed to list calendars', res.status, data);
  return data.calendars || [];
}

function listAppointments({ calendarId, startTime, endTime }) {
  const { locationId } = config();
  return request('GET', '/calendars/events', {
    query: { locationId, calendarId, startTime, endTime },
  }).then((d) => d.events || []);
}

function createAppointment({ calendarId, contactId, startTime, endTime, title }) {
  const { locationId } = config();
  return request('POST', '/calendars/events/appointments', {
    body: { locationId, calendarId, contactId, startTime, endTime, title },
  }).then((d) => d.appointment || d.event || d);
}

// The calendar this tenant has chosen (in the Admin portal) for every new-
// job appointment -- no per-job choice in the portal UI.
function getDefaultCalendarId() {
  const id = tenantStorage.getStore()?.calendarId;
  if (!id) throw new GhlApiError('This account is not connected to GHL yet.', 409);
  return id;
}

function getFreeSlots({ calendarId, startDate, endDate, timezone }) {
  return request('GET', `/calendars/${calendarId}/free-slots`, {
    query: { startDate, endDate, timezone },
  });
}

// ---------- Opportunities (Jobs) ----------

async function listJobsRaw({ pipelineId, pipelineStageId, contactId, query, limit } = {}) {
  const { locationId } = config();
  const data = await request('GET', '/opportunities/search', {
    query: {
      location_id: locationId,
      pipeline_id: pipelineId,
      pipeline_stage_id: pipelineStageId,
      contact_id: contactId,
      query,
      limit: limit || 100,
    },
  });
  return data.opportunities || [];
}

function getJobRaw(id) {
  return request('GET', `/opportunities/${id}`).then((d) => d.opportunity);
}

function createJobRaw({ name, pipelineId, pipelineStageId, status, contactId, monetaryValue, customFields }) {
  const { locationId } = config();
  return request('POST', '/opportunities/', {
    body: { locationId, name, pipelineId, pipelineStageId, status, contactId, monetaryValue, customFields },
  }).then((d) => d.opportunity);
}

function updateJobRaw(id, { name, pipelineStageId, status, monetaryValue, customFields }) {
  return request('PUT', `/opportunities/${id}`, {
    body: { name, pipelineStageId, status, monetaryValue, customFields },
  }).then((d) => d.opportunity);
}

function deleteJob(id) {
  return request('DELETE', `/opportunities/${id}`);
}

function createPipeline({ name, stageNames }) {
  const { locationId } = config();
  return request('POST', '/opportunities/pipelines', {
    body: { locationId, name, stages: (stageNames || []).map((n, i) => ({ name: n, position: i })) },
  }).then((d) => {
    pipelinesCache.delete(locationId);
    return d.pipeline || d;
  });
}

// ---------- Job <-> Opportunity mappers ----------
// GHL calls these "opportunities"; the portal calls them "jobs" everywhere.

function toJob(opportunity, fieldIds) {
  if (!opportunity) return null;
  // GHL is inconsistent here: /opportunities/search returns fieldValueString,
  // /opportunities/{id} returns fieldValue -- accept either shape.
  const cfMap = new Map(
    (opportunity.customFields || []).map((f) => [
      f.id,
      f.value ?? f.fieldValue ?? f.fieldValueString ?? f.fieldValueNumber ?? null,
    ])
  );
  return {
    id: opportunity.id,
    name: opportunity.name,
    contactId: opportunity.contactId,
    customerName: opportunity.contact?.name || opportunity.contact?.fullName || null,
    pipelineId: opportunity.pipelineId,
    stageId: opportunity.pipelineStageId,
    status: opportunity.status,
    value: opportunity.monetaryValue,
    createdAt: opportunity.createdAt,
    updatedAt: opportunity.updatedAt,
    lastStageChangeAt: opportunity.lastStageChangeAt || null,
    lastStatusChangeAt: opportunity.lastStatusChangeAt || null,
    carMake: (fieldIds && cfMap.get(fieldIds.carMake)) || null,
    carModel: (fieldIds && cfMap.get(fieldIds.carModel)) || null,
    damageDescription: (fieldIds && cfMap.get(fieldIds.damageDescription)) || null,
  };
}

async function listJobs(filters) {
  const [raw, stageNames, fieldIds] = await Promise.all([
    listJobsRaw(filters),
    stageNameLookup(),
    ensureJobCustomFields(),
  ]);
  return raw.map((o) => ({ ...toJob(o, fieldIds), stageName: stageNames.get(o.pipelineStageId) || null }));
}

// Every opportunity custom field that has a value on this specific job,
// resolved to its real name -- shown as a generic "Opportunity Fields" list
// in the Job Detail view so nothing set in GHL (by this portal or directly
// by the shop) is hidden from the non-technical user.
function buildCustomFieldsDisplay(raw, fieldDefs) {
  const defsById = new Map(fieldDefs.map((f) => [f.id, f]));
  return (raw.customFields || [])
    .map((f) => {
      const def = defsById.get(f.id);
      const dataType = def?.dataType || null;
      let value = f.value ?? f.fieldValue ?? f.fieldValueString ?? f.fieldValueNumber ?? null;
      // FILE_UPLOAD values are an array of { url, meta, deleted } objects,
      // not plain strings -- flatten to just the URLs for display.
      if (dataType === 'FILE_UPLOAD' && Array.isArray(value)) {
        value = value.filter((v) => v && !v.deleted).map((v) => v.url).filter(Boolean);
      }
      return { id: f.id, name: def?.name || 'Unknown Field', dataType, value };
    })
    .filter((f) => f.value !== null && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0));
}

async function getJob(id) {
  const [raw, stageNames, fieldIds, fieldDefs] = await Promise.all([
    getJobRaw(id),
    stageNameLookup(),
    ensureJobCustomFields(),
    listOpportunityFieldDefs(),
  ]);
  if (!raw) return null;
  return {
    ...toJob(raw, fieldIds),
    stageName: stageNames.get(raw.pipelineStageId) || null,
    customFieldsDisplay: buildCustomFieldsDisplay(raw, fieldDefs),
  };
}

async function createJob(input) {
  const fieldIds = await ensureJobCustomFields();
  const customFields = buildCustomFieldsPayload(input, fieldIds);
  const raw = await createJobRaw({ ...input, customFields });
  const stageNames = await stageNameLookup();
  return { ...toJob(raw, fieldIds), stageName: stageNames.get(raw.pipelineStageId) || null };
}

async function updateJob(id, input) {
  const fieldIds = await ensureJobCustomFields();
  const customFields = buildCustomFieldsPayload(input, fieldIds) || [];
  if (input.photoFieldValues) {
    for (const [fieldId, value] of Object.entries(input.photoFieldValues)) {
      customFields.push({ id: fieldId, value });
    }
  }
  const raw = await updateJobRaw(id, { ...input, customFields: customFields.length ? customFields : undefined });
  const stageNames = await stageNameLookup();
  return { ...toJob(raw, fieldIds), stageName: stageNames.get(raw.pipelineStageId) || null };
}

module.exports = {
  GhlApiError,
  runWithTenant,
  getTenant,
  listContacts,
  getContact,
  getContactsCount,
  countContactsCreatedSince,
  createContact,
  updateContact,
  deleteContact,
  findOrCreateContact,
  addTags,
  removeTags,
  listTags,
  searchContacts,
  listPipelines,
  getDefaultPipelineId,
  createPipeline,
  ensureJobCustomFields,
  ensureCategoryFields,
  assignCategoryFiles,
  uploadMedia,
  createConversation,
  findOrCreateConversation,
  listConversations,
  getConversationMessages,
  sendMessage,
  listPhoneNumbers,
  listCalendars,
  listCalendarsFor,
  listAppointments,
  createAppointment,
  getDefaultCalendarId,
  getFreeSlots,
  listJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
};
