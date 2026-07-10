const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const conversations = await ghl.listConversations({ limit: 50 });
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

router.get('/numbers', async (req, res, next) => {
  try {
    const phoneNumbers = await ghl.listPhoneNumbers();
    res.json({ phoneNumbers });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/messages', async (req, res, next) => {
  try {
    const messages = await ghl.getConversationMessages(req.params.id);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/messages', async (req, res, next) => {
  const { contactId, message, fromNumber } = req.body || {};
  const userEmail = req.user.email;
  if (!contactId || !message) return res.status(400).json({ error: 'contactId and message are required' });

  try {
    const result = await ghl.sendMessage({ contactId, message, type: 'SMS', fromNumber });
    await logSync({
      userEmail,
      action: 'conversation.message.send',
      entityType: 'conversation',
      entityId: req.params.id,
      request: { contactId, message, fromNumber },
      success: true,
    });
    res.status(201).json(result);
  } catch (err) {
    await logSync({
      userEmail,
      action: 'conversation.message.send',
      entityType: 'conversation',
      entityId: req.params.id,
      request: { contactId, message, fromNumber },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
