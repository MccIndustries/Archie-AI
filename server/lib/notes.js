const ghl = require('./ghlClient');
const { getSupabase } = require('./supabase');

function locationId() {
  return ghl.getTenant()?.locationId || 'unknown';
}

// GHL has no separate "opportunity note" concept -- job-sourced notes are
// mirrored onto the contact's real GHL notes too, prefixed with the job's
// case number so they're identifiable there.
function mirrorBody({ source, jobId, body }) {
  return source === 'job' ? `[Job #${jobId}] ${body}` : body;
}

// Notes added directly in GHL (not through the portal) have no row in our
// own table at all, so they'd never show up here otherwise -- this is the
// composite id ("ghl:<contactId>:<ghlNoteId>") used to identify them for
// later edit/delete, since they have no local uuid to look up by.
function externalNoteId(contactId, ghlNoteId) {
  return `ghl:${contactId}:${ghlNoteId}`;
}

function parseExternalNoteId(id) {
  const m = /^ghl:([^:]+):(.+)$/.exec(id || '');
  return m ? { contactId: m[1], ghlNoteId: m[2] } : null;
}

async function listNotesForContact(contactId) {
  const [localResult, ghlNotes] = await Promise.all([
    getSupabase()
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .eq('location_id', locationId())
      .order('created_at', { ascending: false }),
    ghl.listGhlNotes(contactId).catch(() => []),
  ]);
  if (localResult.error) throw localResult.error;
  const local = localResult.data || [];

  // A note created through the portal already has a row here (tracked by
  // ghl_note_id) -- only notes GHL doesn't already know about via us need
  // to be synthesized as "external" entries.
  const trackedGhlIds = new Set(local.map((n) => n.ghl_note_id).filter(Boolean));
  const external = ghlNotes
    .filter((gn) => !trackedGhlIds.has(gn.id))
    .map((gn) => ({
      id: externalNoteId(contactId, gn.id),
      created_at: gn.dateAdded,
      updated_at: gn.dateAdded,
      location_id: locationId(),
      contact_id: contactId,
      job_id: null,
      source: 'contact',
      body: gn.body,
      created_by: null,
      ghl_note_id: gn.id,
      external: true,
    }));

  return [...local, ...external].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function listNotesForJob(jobId) {
  const { data, error } = await getSupabase()
    .from('contact_notes')
    .select('*')
    .eq('job_id', jobId)
    .eq('location_id', locationId())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function createNote({ contactId, jobId, body, userEmail }) {
  const source = jobId ? 'job' : 'contact';
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('contact_notes')
    .insert({
      location_id: locationId(),
      contact_id: contactId,
      job_id: jobId || null,
      source,
      body,
      created_by: userEmail || null,
    })
    .select()
    .single();
  if (error) throw error;

  let warning = null;
  try {
    const ghlNote = await ghl.createGhlNote(contactId, mirrorBody({ source, jobId, body }));
    const { data: updated, error: updateErr } = await supabase
      .from('contact_notes')
      .update({ ghl_note_id: ghlNote.id })
      .eq('id', data.id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    return { note: updated, warning: null };
  } catch (err) {
    warning = `Note saved, but could not sync to GHL: ${err.message}`;
  }
  return { note: data, warning };
}

async function getNoteRow(id) {
  const { data, error } = await getSupabase()
    .from('contact_notes')
    .select('*')
    .eq('id', id)
    .eq('location_id', locationId())
    .single();
  if (error) return null;
  return data;
}

async function updateNote(id, { body }) {
  const ext = parseExternalNoteId(id);
  if (ext) {
    await ghl.updateGhlNote(ext.contactId, ext.ghlNoteId, body);
    return {
      note: {
        id,
        body,
        contact_id: ext.contactId,
        job_id: null,
        source: 'contact',
        ghl_note_id: ext.ghlNoteId,
        external: true,
        updated_at: new Date().toISOString(),
      },
      warning: null,
    };
  }

  const row = await getNoteRow(id);
  if (!row) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('contact_notes')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  let warning = null;
  const mirrored = mirrorBody({ source: row.source, jobId: row.job_id, body });
  try {
    if (row.ghl_note_id) {
      await ghl.updateGhlNote(row.contact_id, row.ghl_note_id, mirrored);
    } else {
      const ghlNote = await ghl.createGhlNote(row.contact_id, mirrored);
      await supabase.from('contact_notes').update({ ghl_note_id: ghlNote.id }).eq('id', id);
    }
  } catch (err) {
    warning = `Note updated, but could not sync to GHL: ${err.message}`;
  }
  return { note: data, warning };
}

async function deleteNote(id) {
  const ext = parseExternalNoteId(id);
  if (ext) {
    await ghl.deleteGhlNote(ext.contactId, ext.ghlNoteId);
    return { contact_id: ext.contactId, external: true };
  }

  const row = await getNoteRow(id);
  if (!row) return null;
  if (row.ghl_note_id) {
    try {
      await ghl.deleteGhlNote(row.contact_id, row.ghl_note_id);
    } catch {
      // best-effort -- still remove the portal's own row even if the GHL
      // side is already gone or unreachable
    }
  }
  const { error } = await getSupabase().from('contact_notes').delete().eq('id', id);
  if (error) throw error;
  return row;
}

module.exports = {
  listNotesForContact,
  listNotesForJob,
  createNote,
  updateNote,
  deleteNote,
};
