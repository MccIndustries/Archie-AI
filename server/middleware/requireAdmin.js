const { getSupabase } = require('../lib/supabase');

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });

  if (data.user.app_metadata?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}

module.exports = requireAdmin;
