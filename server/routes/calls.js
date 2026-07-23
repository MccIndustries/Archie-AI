const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

// Dashboard's "Calls Done" KPI -- every AI-agent-handled call location-wide
// (not just one page), newest first, each resolved to its contact's
// name/phone since the call log itself only carries a bare contactId.
// Contact lookups are deduped by contactId (a Map of in-flight promises) so
// a contact with several calls only costs one fetch, not one per call.
router.get('/recent', async (req, res, next) => {
  try {
    const { callLogs, total } = await ghl.listAllVoiceAiCallLogs();
    const sorted = callLogs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const contactByIdPromise = new Map();
    const calls = await Promise.all(
      sorted.map(async (c) => {
        if (!contactByIdPromise.has(c.contactId)) {
          contactByIdPromise.set(c.contactId, ghl.getContact(c.contactId).catch(() => null));
        }
        const contact = await contactByIdPromise.get(c.contactId);
        return {
          id: c.id,
          messageId: c.messageId,
          contactId: c.contactId,
          contactName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.name : null,
          phone: contact?.phone || c.fromNumber || null,
          duration: c.duration,
          summary: c.summary,
          createdAt: c.createdAt,
        };
      })
    );
    res.json({ calls, total });
  } catch (err) {
    next(err);
  }
});

// Everything the call detail popup needs beyond what's already on the
// conversation thread's own message (direction/duration/status): the Voice
// AI summary/transcript/extracted-data if an AI agent handled the call, plus
// a best-effort generic transcript for any other recorded call.
router.get('/:messageId/detail', async (req, res, next) => {
  try {
    const contactId = req.query.contactId;
    const [callLogs, transcription] = await Promise.all([
      contactId ? ghl.listVoiceAiCallLogs(contactId) : Promise.resolve([]),
      ghl.getMessageTranscription(req.params.messageId),
    ]);
    const voiceAi = callLogs.find((c) => c.messageId === req.params.messageId) || null;
    res.json({ voiceAi, transcription });
  } catch (err) {
    next(err);
  }
});

router.get('/:messageId/recording', async (req, res, next) => {
  try {
    const { buffer, contentType } = await ghl.getCallRecording(req.params.messageId);
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    if (err.status) return res.status(404).json({ error: 'No recording available for this call' });
    next(err);
  }
});

module.exports = router;
