const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const { listNotesForContact, createNote } = require('../lib/notes');
const { listSmartLists, createSmartList, updateSmartList, deleteSmartList } = require('../lib/smartLists');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

// Registered ahead of GET/PUT/DELETE /:id so these fixed paths ("smart-lists",
// "field-defs") are never mistaken for a contact id.
router.get('/smart-lists', async (req, res, next) => {
  try {
    const smartLists = await listSmartLists();
    res.json({ smartLists });
  } catch (err) {
    next(err);
  }
});

router.post('/smart-lists', async (req, res, next) => {
  const { name, filters } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const smartList = await createSmartList({ name: name.trim(), filters, userEmail: req.user.email });
    res.status(201).json({ smartList });
  } catch (err) {
    next(err);
  }
});

router.put('/smart-lists/:id', async (req, res, next) => {
  const { name, filters } = req.body || {};
  try {
    const smartList = await updateSmartList(req.params.id, { name: name?.trim(), filters });
    res.json({ smartList });
  } catch (err) {
    next(err);
  }
});

router.delete('/smart-lists/:id', async (req, res, next) => {
  try {
    await deleteSmartList(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/field-defs', async (req, res, next) => {
  try {
    const fieldDefs = await ghl.listContactFieldDefs();
    res.json({ fieldDefs });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { query, limit, tags, dateFrom, dateTo } = req.query;
    const tagList = tags
      ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    if (tagList.length || dateFrom || dateTo) {
      const { contacts, total } = await ghl.searchContacts({ query, tags: tagList, dateFrom, dateTo, limit });
      return res.json({ contacts, total });
    }
    const contacts = await ghl.listContacts({ query, limit });
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.get('/tags', async (req, res, next) => {
  try {
    const tags = await ghl.listTags();
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const contact = await ghl.getContact(req.params.id);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { firstName, lastName, email, phone, tags } = req.body || {};
  try {
    const contact = await ghl.createContact({ firstName, lastName, email, phone, tags });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.create',
      entityType: 'contact',
      entityId: contact.id,
      request: req.body,
      success: true,
    });
    res.status(201).json({ contact });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.create',
      entityType: 'contact',
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const { firstName, lastName, email, phone, customFields } = req.body || {};
  try {
    const contact = await ghl.updateContact(req.params.id, { firstName, lastName, email, phone, customFields });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.update',
      entityType: 'contact',
      entityId: req.params.id,
      request: req.body,
      success: true,
    });
    res.json({ contact });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.update',
      entityType: 'contact',
      entityId: req.params.id,
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.post('/:id/tags', async (req, res, next) => {
  const { tags } = req.body || {};
  try {
    const result = await ghl.addTags(req.params.id, tags);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.add',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: true,
    });
    res.json(result);
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.add',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await ghl.deleteContact(req.params.id);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.delete',
      entityType: 'contact',
      entityId: req.params.id,
      success: true,
    });
    res.status(204).end();
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.delete',
      entityType: 'contact',
      entityId: req.params.id,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.get('/:id/notes', async (req, res, next) => {
  try {
    const notes = await listNotesForContact(req.params.id);
    res.json({ notes });
  } catch (err) {
    next(err);
  }
});

// GHL has no "list appointments for this contact" endpoint -- appointments
// are only queryable per-calendar. Same wide window as the Calendar tab's
// own per-calendar query (90 days back, a year forward), just fanned out
// across every calendar and filtered down to this one contact.
router.get('/:id/appointments', async (req, res, next) => {
  try {
    const contactId = req.params.id;
    const calendars = await ghl.listCalendars();
    const startTime = (Date.now() - 90 * 24 * 60 * 60 * 1000).toString();
    const endTime = (Date.now() + 365 * 24 * 60 * 60 * 1000).toString();
    const lists = await Promise.all(
      calendars.map((c) =>
        ghl.listAppointments({ calendarId: c.id, startTime, endTime }).then((events) =>
          events.filter((e) => e.contactId === contactId).map((e) => ({ ...e, calendarName: c.name }))
        )
      )
    );
    const appointments = lists
      .flat()
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      .map((e) => ({ id: e.id, title: e.title, calendarName: e.calendarName, startTime: e.startTime, endTime: e.endTime, status: e.appointmentStatus || e.status }));
    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/notes', async (req, res, next) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const { note, warning } = await createNote({ contactId: req.params.id, body, userEmail: req.user.email });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.note.create',
      entityType: 'contact',
      entityId: req.params.id,
      success: true,
    });
    res.status(201).json({ note, warning });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/tags', async (req, res, next) => {
  const { tags } = req.body || {};
  try {
    const result = await ghl.removeTags(req.params.id, tags);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.remove',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: true,
    });
    res.json(result);
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.remove',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
