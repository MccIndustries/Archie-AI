const { getSupabase } = require('./supabase');

// Creates a Supabase Auth user for this email and sends Supabase's built-in
// invite email, which lands on our own set-password.html (customized in the
// Supabase dashboard's Email Templates). inviteUserByEmail doesn't accept
// app_metadata directly -- confirmed live -- so the tag is applied in a
// second call right after. Shared by client-login invites (tagged
// client_id), admin invites (tagged role: 'admin'), and the GHL signup
// webhook.
async function inviteUser({ email, appMetadata }) {
  const { data, error } = await getSupabase().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.APP_BASE_URL}/set-password.html`,
  });
  if (error) throw error;
  const { error: tagErr } = await getSupabase().auth.admin.updateUserById(data.user.id, {
    app_metadata: appMetadata,
  });
  if (tagErr) throw tagErr;
  return data.user;
}

function inviteUserForClient({ email, clientId }) {
  return inviteUser({ email, appMetadata: { client_id: clientId } });
}

module.exports = { inviteUser, inviteUserForClient };
