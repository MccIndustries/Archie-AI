const express = require('express');
const ghl = require('../lib/ghlClient');
const { getSupabase } = require('../lib/supabase');
const requireAdmin = require('../middleware/requireAdmin');

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

// Creates a Supabase Auth user for this email and sends Supabase's built-in
// invite email, which lands on our own set-password.html (customized in the
// Supabase dashboard's Email Templates). inviteUserByEmail doesn't accept
// app_metadata directly -- confirmed live -- so the client_id tag is applied
// in a second call right after.
async function inviteUserForClient({ email, clientId }) {
  const { data, error } = await getSupabase().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.APP_BASE_URL}/set-password.html`,
  });
  if (error) throw error;
  const { error: tagErr } = await getSupabase().auth.admin.updateUserById(data.user.id, {
    app_metadata: { client_id: clientId },
  });
  if (tagErr) throw tagErr;
  return data.user;
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

// "Create New Account" -- just a business name + the owner's email. GHL
// credentials are deliberately not collected here; they're added later via
// the client detail card, once the account already exists and the owner
// has already set their own password.
router.post('/clients', async (req, res, next) => {
  const { name, email } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const { data: client, error } = await getSupabase()
      .from('clients')
      .insert({ name })
      .select()
      .single();
    if (error) throw error;

    try {
      await inviteUserForClient({ email, clientId: client.id });
    } catch (inviteErr) {
      // Don't leave a loginless, confusing client record behind -- let the
      // VA just retry "Create New Account" cleanly instead.
      await getSupabase().from('clients').delete().eq('id', client.id);
      throw inviteErr;
    }

    res.status(201).json({ client: { ...client, ghl_api_token: maskToken(client.ghl_api_token), connected: isConnected(client) } });
  } catch (err) {
    next(err);
  }
});

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

module.exports = router;
