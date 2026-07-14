const express = require('express');
const multer = require('multer');
const ghl = require('../lib/ghlClient');
const { logSync, listJobFiles, uploadJobFile } = require('../lib/supabase');
const { listNotesForJob, createNote } = require('../lib/notes');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.get('/', async (req, res, next) => {
  try {
    const { contactId, stageId, pipelineId, query } = req.query;
    const jobs = await ghl.listJobs({
      contactId,
      pipelineStageId: stageId,
      pipelineId,
      query,
    });
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const job = await ghl.getJob(req.params.id);
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/files', async (req, res, next) => {
  try {
    const files = await listJobFiles(req.params.id);
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/files', upload.array('files', 10), async (req, res, next) => {
  const jobId = req.params.id;
  const category = (req.body?.category || '').trim();
  const userEmail = req.user.email;
  const warnings = [];

  if (!category) return res.status(400).json({ error: 'category is required' });
  if (!req.files?.length) return res.status(400).json({ error: 'at least one file is required' });

  try {
    let uploadedCount = 0;
    const ghlUrls = [];
    for (const file of req.files) {
      try {
        await uploadJobFile({
          jobId,
          filename: file.originalname,
          buffer: file.buffer,
          contentType: file.mimetype,
          uploadedBy: userEmail,
          category,
        });
        uploadedCount += 1;
      } catch (err) {
        warnings.push(`"${file.originalname}" failed to upload to storage: ${err.message}`);
      }

      try {
        const uploaded = await ghl.uploadMedia({
          buffer: file.buffer,
          filename: file.originalname,
          contentType: file.mimetype,
        });
        ghlUrls.push(uploaded.url);
      } catch (err) {
        warnings.push(`"${file.originalname}" failed to upload to GHL: ${err.message}`);
      }
    }

    if (ghlUrls.length) {
      try {
        await ghl.assignCategoryFiles(jobId, category, ghlUrls);
      } catch (err) {
        warnings.push(`Files uploaded to GHL but could not be attached to the job: ${err.message}`);
      }
    }

    await logSync({
      userEmail,
      action: 'job.files.upload',
      entityType: 'job',
      entityId: jobId,
      request: { category, count: uploadedCount },
      success: uploadedCount === req.files.length,
    });

    res.status(201).json({ uploadedCount, warnings });
  } catch (err) {
    await logSync({
      userEmail,
      action: 'job.files.upload',
      entityType: 'job',
      entityId: jobId,
      request: { category },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.get('/:id/notes', async (req, res, next) => {
  try {
    const notes = await listNotesForJob(req.params.id);
    res.json({ notes });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/notes', async (req, res, next) => {
  const jobId = req.params.id;
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const job = await ghl.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { note, warning } = await createNote({ contactId: job.contactId, jobId, body, userEmail: req.user.email });
    await logSync({
      userEmail: req.user.email,
      action: 'job.note.create',
      entityType: 'job',
      entityId: jobId,
      success: true,
    });
    res.status(201).json({ note, warning });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { name, contactId, stageId, status, value, carMake, carModel, damageDescription } = req.body || {};
  try {
    const pipelineId = req.body.pipelineId || (await ghl.getDefaultPipelineId());
    const job = await ghl.createJob({
      name,
      contactId,
      pipelineId,
      pipelineStageId: stageId,
      status: status || 'open',
      monetaryValue: value,
      carMake,
      carModel,
      damageDescription,
    });
    await logSync({
      userEmail: req.user.email,
      action: 'job.create',
      entityType: 'job',
      entityId: job.id,
      request: req.body,
      success: true,
    });
    res.status(201).json({ job });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'job.create',
      entityType: 'job',
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const { name, stageId, status, value, carMake, carModel, damageDescription } = req.body || {};
  try {
    const job = await ghl.updateJob(req.params.id, {
      name,
      pipelineStageId: stageId,
      status,
      monetaryValue: value,
      carMake,
      carModel,
      damageDescription,
    });
    await logSync({
      userEmail: req.user.email,
      action: stageId ? 'job.stage.move' : 'job.update',
      entityType: 'job',
      entityId: req.params.id,
      request: req.body,
      success: true,
    });
    res.json({ job });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: stageId ? 'job.stage.move' : 'job.update',
      entityType: 'job',
      entityId: req.params.id,
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await ghl.deleteJob(req.params.id);
    await logSync({
      userEmail: req.user.email,
      action: 'job.delete',
      entityType: 'job',
      entityId: req.params.id,
      success: true,
    });
    res.status(204).end();
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'job.delete',
      entityType: 'job',
      entityId: req.params.id,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
