// Gates routes that talk to GHL: a logged-in user whose client hasn't had
// GHL credentials added yet (in the Admin portal) should get a clear,
// machine-readable error the frontend can turn into its "not connected"
// banner, rather than a generic GHL API failure. Must run after requireAuth
// (which attaches req.tenant).
function requireConnected(req, res, next) {
  if (!req.tenant?.connected) {
    return res.status(409).json({ error: 'not_connected' });
  }
  next();
}

module.exports = requireConnected;
