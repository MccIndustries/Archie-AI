const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

// Every tenant is strictly locked to one pipeline (whichever GHL pipeline
// is named "Repair Status", matched by the Admin portal and stored as
// tenant.pipelineId) -- this returns just that one pipeline, not every
// pipeline in the GHL account, so every caller (Active Jobs board,
// Dashboard's pipeline filter, Monthly Report) only ever shows the one.
router.get('/', async (req, res, next) => {
  try {
    if (!req.tenant?.pipelineId) return res.json({ pipelines: [] });
    const pipelines = await ghl.listPipelines({ fresh: req.query.fresh === 'true' });
    const match = pipelines.find((p) => p.id === req.tenant.pipelineId);
    res.json({ pipelines: match ? [match] : [] });
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
