const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

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
