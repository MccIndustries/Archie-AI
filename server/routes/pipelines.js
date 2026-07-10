const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const pipelines = await ghl.listPipelines({ fresh: req.query.fresh === 'true' });
    res.json({ pipelines });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { name, stageNames } = req.body || {};
  try {
    const pipeline = await ghl.createPipeline({ name, stageNames });
    await logSync({
      userEmail: req.user.email,
      action: 'pipeline.create',
      entityType: 'pipeline',
      entityId: pipeline.id,
      request: req.body,
      success: true,
    });
    res.status(201).json({ pipeline });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'pipeline.create',
      entityType: 'pipeline',
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
