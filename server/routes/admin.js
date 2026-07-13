const express = require('express');
const ghl = require('../lib/ghlClient');
const { getSupabase } = require('../lib/supabase');
const requireAdmin = require('../middleware/requireAdmin');
const { inviteUser, inviteUserForClient } = require('../lib/invites');

const router = express.Router();
router.use(requireAdmin);

// Lets the Add Client form fetch real calendars using the token/location
// just typed in, before that client is saved anywhere.
router.post('/ghl/calendars', async (req, res, next) => {
  const { ghlApiToken, ghlLocationId } = req.body || {};
  if (!ghlApiToken || !ghlLocationId) {
    return res.status(400).json({ error: 'ghlApiToken and ghlLocationId are required' });
  }
  try {
    const calendars = await ghl.listCalendarsFor({ apiToken: ghlApiToken, locationId: ghlLocationId });
    res.json({ calendars });
  } catch (err) {
    next(err);
  }
});

function maskToken(token) {
  if (!token) return null;
  return `${'•'.repeat(8)}${token.slice(-4)}`;
}

function isConnected(c) {
  return Boolean(c.ghl_location_id && c.ghl_api_token && c.ghl_calendar_id);
}

router.get('/clients', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({
      clients: (data || []).map((c) => ({
        ...c,
        ghl_api_token: maskToken(c.ghl_api_token),
        connected: isConnected(c),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase().from('clients').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    const reveal = req.query.reveal === 'true';
    const client = reveal ? data : { ...data, ghl_api_token: maskToken(data.ghl_api_token) };
    res.json({ client: { ...client, connected: isConnected(data) } });
  } catch (err) {
    next(err);
  }
});

// Client accounts are no longer created by hand here -- they're created by
// the GHL signup webhook (server/routes/webhooks.js) when the "Portal
// Optin" form is submitted. The VA's only job is filling in GHL
// credentials below, once the account already shows up as Not Connected.
router.put('/clients/:id', async (req, res, next) => {
  const { name, ghlLocationId, ghlApiToken, ghlCalendarId, ghlPipelineId, notes } = req.body || {};
  try {
    const update = {};
    if (name !== undefined) update.name = name;
    if (ghlLocationId !== undefined) update.ghl_location_id = ghlLocationId;
    if (ghlApiToken) update.ghl_api_token = ghlApiToken; // only overwrite if a new one was actually provided
    if (ghlCalendarId !== undefined) update.ghl_calendar_id = ghlCalendarId;
    if (ghlPipelineId !== undefined) update.ghl_pipeline_id = ghlPipelineId;
    if (notes !== undefined) update.notes = notes;

    const { data, error } = await getSupabase().from('clients').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ client: { ...data, ghl_api_token: maskToken(data.ghl_api_token), connected: isConnected(data) } });
  } catch (err) {
    next(err);
  }
});

router.delete('/clients/:id', async (req, res, next) => {
  try {
    const { error } = await getSupabase().from('clients').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id/users', async (req, res, next) => {
  try {
    const { data: list, error: listErr } = await getSupabase().auth.admin.listUsers();
    if (listErr) throw listErr;

    const users = list.users
      .filter((u) => u.app_metadata?.client_id === req.params.id)
      .map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at }));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// "Switch to Account" -- lets an agency admin jump straight into a client's
// own portal session without knowing their password. Generates a Supabase
// magic-link for that client's earliest portal login and hands back the
// action link; the frontend opens it directly, which lets Supabase's JS
// client (detectSessionInUrl, already relied on for invite links) pick up
// a real session for that user. Note this replaces whatever session is in
// the browser's local storage for this origin -- the admin will need to
// log back in to admin.html afterward to return to the Admin portal.
router.post('/clients/:id/impersonate', async (req, res, next) => {
  try {
    const { data: list, error } = await getSupabase().auth.admin.listUsers();
    if (error) throw error;

    const users = list.users
      .filter((u) => u.app_metadata?.client_id === req.params.id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (!users.length) {
      return res.status(404).json({ error: 'This client has no portal login yet.' });
    }

    const { data, error: linkErr } = await getSupabase().auth.admin.generateLink({
      type: 'magiclink',
      email: users[0].email,
      options: { redirectTo: `${process.env.APP_BASE_URL}/index.html` },
    });
    if (linkErr) throw linkErr;
    res.json({ actionLink: data.properties.action_link });
  } catch (err) {
    next(err);
  }
});

// "+ Invite User" -- an additional staff login for an already-existing
// client, same invite-email + self-set-password flow as account creation.
router.post('/clients/:id/users', async (req, res, next) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const user = await inviteUserForClient({ email, clientId: req.params.id });
    res.status(201).json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin users (agency staff, not client logins) ----------

router.get('/admins', async (req, res, next) => {
  try {
    const { data: list, error } = await getSupabase().auth.admin.listUsers();
    if (error) throw error;

    const admins = list.users
      .filter((u) => u.app_metadata?.role === 'admin')
      .map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at }));
    res.json({ admins });
  } catch (err) {
    next(err);
  }
});

// "+ Invite Admin" -- same invite-email + self-set-password flow as client
// logins, just tagged role: 'admin' instead of client_id. Any existing
// admin can invite another; there's no separate approval step.
router.post('/admins', async (req, res, next) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const user = await inviteUser({ email, appMetadata: { role: 'admin' } });
    res.status(201).json({ admin: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
