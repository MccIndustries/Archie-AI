const express = require('express');
const { getSupabase } = require('../lib/supabase');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('sync_log')
      .select('*')
      .eq('location_id', req.tenant.locationId || 'unknown')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ activity: data || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
