const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/contacts', async (req, res, next) => {
  try {
    // GHL's basic list endpoint has a practical cap -- a location with more
    // contacts than this would be truncated. Acceptable for now; flagged
    // rather than silently wrong.
    const contacts = await ghl.listContacts({ limit: 100 });
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.get('/pipeline', async (req, res, next) => {
  try {
    const pipelines = await ghl.listPipelines();
    if (!pipelines.length) return res.json({ pipeline: null, stages: [], jobs: [] });

    const pipelineId = req.query.pipelineId || (await ghl.getDefaultPipelineId());
    const pipeline = pipelines.find((p) => p.id === pipelineId) || pipelines[0];
    const jobs = await ghl.listJobs({ pipelineId: pipeline.id });

    const stages = (pipeline.stages || []).map((stage) => ({
      stageId: stage.id,
      stageName: stage.name,
      count: jobs.filter((j) => j.stageId === stage.id).length,
      value: jobs.filter((j) => j.stageId === stage.id).reduce((sum, j) => sum + (Number(j.value) || 0), 0),
    }));

    res.json({ pipeline: { id: pipeline.id, name: pipeline.name }, stages, jobs });
  } catch (err) {
    next(err);
  }
});

router.get('/revenue', async (req, res, next) => {
  try {
    const jobs = await ghl.listJobs({});
    const won = jobs.filter((j) => j.status === 'won');
    const open = jobs.filter((j) => j.status === 'open');
    const lost = jobs.filter((j) => j.status === 'lost');

    res.json({
      totalRevenue: won.reduce((sum, j) => sum + (Number(j.value) || 0), 0),
      pipelineValue: open.reduce((sum, j) => sum + (Number(j.value) || 0), 0),
      wonCount: won.length,
      openCount: open.length,
      lostCount: lost.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sales-by-month', async (req, res, next) => {
  try {
    const jobs = await ghl.listJobs({});
    const won = jobs.filter((j) => j.status === 'won' && j.lastStatusChangeAt);

    const byMonth = new Map();
    for (const j of won) {
      const month = j.lastStatusChangeAt.slice(0, 7); // 'YYYY-MM'
      const entry = byMonth.get(month) || { month, revenue: 0, count: 0 };
      entry.revenue += Number(j.value) || 0;
      entry.count += 1;
      byMonth.set(month, entry);
    }

    const rows = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
