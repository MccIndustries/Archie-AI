const express = require('express');
const multer = require('multer');
const ghl = require('../lib/ghlClient');
const { logSync, uploadJobFile } = require('../lib/supabase');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/', upload.array('photos', 10), async (req, res, next) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    carMake,
    carModel,
    damageDescription,
    pipelineId,
    value,
    startTime,
  } = req.body || {};
  const userEmail = req.user.email;
  const warnings = [];

  try {
    // 1. Contact -- reuse an existing one (matched by phone or email) rather
    // than letting GHL's own duplicate-contact block fail the whole intake.
    // A new job/opportunity still gets created either way below.
    const { contact, reused: contactReused } = await ghl.findOrCreateContact({
      firstName,
      lastName,
      email,
      phone,
      tags: ['flowsuite-intake'],
    });
    if (contactReused) await ghl.addTags(contact.id, ['flowsuite-intake']).catch(() => {});
    await logSync({
      userEmail,
      action: contactReused ? 'intake.contact.reuse' : 'intake.contact.create',
      entityType: 'contact',
      entityId: contact.id,
      request: { firstName, lastName, email, phone },
      success: true,
    });

    // 2. Conversation (best-effort)
    let conversation = null;
    try {
      conversation = await ghl.createConversation({ contactId: contact.id });
      await logSync({
        userEmail,
        action: 'intake.conversation.create',
        entityType: 'contact',
        entityId: contact.id,
        success: true,
      });
    } catch (err) {
      warnings.push(`Conversation could not be created: ${err.message}`);
      await logSync({
        userEmail,
        action: 'intake.conversation.create',
        entityType: 'contact',
        entityId: contact.id,
        success: false,
        error: err.message,
      });
    }

    // 3. Job (opportunity), in the chosen pipeline's first stage
    const targetPipelineId = pipelineId || (await ghl.getDefaultPipelineId());
    const pipelines = await ghl.listPipelines();
    const pipeline = pipelines.find((p) => p.id === targetPipelineId);
    if (!pipeline || !pipeline.stages?.length) {
      throw new ghl.GhlApiError('Selected pipeline has no stages to place the job in', 400);
    }
    const firstStage = pipeline.stages[0];
    const jobName = [carMake, carModel].filter(Boolean).join(' ') || `${firstName} ${lastName}`.trim() || 'New Job';

    const job = await ghl.createJob({
      name: jobName,
      pipelineId: targetPipelineId,
      pipelineStageId: firstStage.id,
      status: 'open',
      contactId: contact.id,
      monetaryValue: Number(value) || 0,
      carMake,
      carModel,
      damageDescription,
      firstName,
      lastName,
      email,
      phone,
    });
    await logSync({
      userEmail,
      action: 'intake.job.create',
      entityType: 'job',
      entityId: job.id,
      request: { carMake, carModel, damageDescription, firstName, lastName, email, phone, value, pipelineId: targetPipelineId },
      success: true,
    });

    // 4. Photos -> dual-stored: Supabase Storage (portal's own retrieval
    // path) AND GHL's media library, referenced on the opportunity via a
    // growable set of "Photos N" FILE_UPLOAD fields (one file per field --
    // GHL silently rejects multi-file values on a single field).
    let photoCount = 0;
    const ghlPhotoUrls = [];
    for (const file of req.files || []) {
      try {
        await uploadJobFile({
          jobId: job.id,
          filename: file.originalname,
          buffer: file.buffer,
          contentType: file.mimetype,
          uploadedBy: userEmail,
          category: 'Photos',
        });
        photoCount += 1;
      } catch (err) {
        warnings.push(`Photo "${file.originalname}" failed to upload to storage: ${err.message}`);
      }

      try {
        const uploaded = await ghl.uploadMedia({
          buffer: file.buffer,
          filename: file.originalname,
          contentType: file.mimetype,
        });
        ghlPhotoUrls.push(uploaded.url);
      } catch (err) {
        warnings.push(`Photo "${file.originalname}" failed to upload to GHL: ${err.message}`);
      }
    }
    await logSync({
      userEmail,
      action: 'intake.job.photos.upload',
      entityType: 'job',
      entityId: job.id,
      request: { count: photoCount },
      success: photoCount === (req.files || []).length,
    });

    if (ghlPhotoUrls.length) {
      try {
        await ghl.assignCategoryFiles(job.id, 'Photos', ghlPhotoUrls);
        await logSync({
          userEmail,
          action: 'intake.job.photos.ghl_upload',
          entityType: 'job',
          entityId: job.id,
          request: { count: ghlPhotoUrls.length },
          success: true,
        });
      } catch (err) {
        warnings.push(`Photos uploaded to GHL but could not be attached to the job: ${err.message}`);
        await logSync({
          userEmail,
          action: 'intake.job.photos.ghl_upload',
          entityType: 'job',
          entityId: job.id,
          success: false,
          error: err.message,
        });
      }
    }

    // 5. Appointment -- always the fixed default calendar, at the exact
    // slot the desk picked (already validated as real availability by
    // GET /api/slots), using that calendar's own slot duration.
    let appointment = null;
    if (startTime) {
      const calendarId = ghl.getDefaultCalendarId();
      const calendars = await ghl.listCalendars();
      const calendar = calendars.find((c) => c.id === calendarId);
      const durationMs = (calendar?.slotDuration || 30) * 60 * 1000;
      const endTime = new Date(new Date(startTime).getTime() + durationMs).toISOString();
      try {
        appointment = await ghl.createAppointment({
          calendarId,
          contactId: contact.id,
          startTime: new Date(startTime).toISOString(),
          endTime,
          title: `Job ${job.id} — ${jobName}`,
        });
        await logSync({
          userEmail,
          action: 'intake.appointment.create',
          entityType: 'job',
          entityId: job.id,
          request: { calendarId, startTime },
          success: true,
        });
      } catch (err) {
        warnings.push(`Appointment could not be booked: ${err.message}`);
        await logSync({
          userEmail,
          action: 'intake.appointment.create',
          entityType: 'job',
          entityId: job.id,
          request: { calendarId, startTime },
          success: false,
          error: err.message,
        });
      }
    }

    res.status(201).json({ contact, contactReused, job, conversation, appointment, photoCount, warnings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
