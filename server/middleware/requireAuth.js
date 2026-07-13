const { getSupabase } = require('../lib/supabase');
const ghl = require('../lib/ghlClient');

// This is a single shared deployment serving every client, so a valid login
// alone doesn't say which client's GHL account to use. Each user is tagged
// (app_metadata.client_id, set via the Auth Admin API when the account is
// created -- not user-editable) with the `clients` row they belong to. That
// row is fetched fresh on every request (deliberately not cached) so that
// saving GHL credentials in the Admin portal takes effect on the very next
// request, with no redeploy or restart.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });

  const clientId = data.user.app_metadata?.client_id;
  if (!clientId) return res.status(403).json({ error: 'This account is not linked to a client.' });

  const { data: client, error: clientErr } = await getSupabase()
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();
  if (clientErr || !client) return res.status(403).json({ error: 'Client account not found.' });

  const connected = Boolean(client.ghl_location_id && client.ghl_api_token && client.ghl_calendar_id);

  req.user = { id: data.user.id, email: data.user.email };
  req.tenant = {
    clientId: client.id,
    businessName: client.name,
    contactName: client.contact_name,
    apiToken: client.ghl_api_token,
    locationId: client.ghl_location_id,
    calendarId: client.ghl_calendar_id,
    pipelineId: client.ghl_pipeline_id,
    connected,
  };

  ghl.runWithTenant(req.tenant, next);
}

module.exports = requireAuth;
