const express = require('express');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

// Public: the browser needs the URL + anon key to talk to Supabase Auth directly.
// brandName is here too -- this is one shared deployment per agency, so the
// product name shown everywhere is a config value, not hardcoded text, since
// a different agency running this same codebase will want their own name.
router.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    brandName: process.env.BRAND_NAME || 'Collision Command',
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    tenant: { businessName: req.tenant.businessName, contactName: req.tenant.contactName, connected: req.tenant.connected },
  });
});

module.exports = router;
