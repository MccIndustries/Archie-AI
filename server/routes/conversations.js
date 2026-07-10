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

// "+ Start Conversation" -- reuses the same find-or-create-contact pattern
// as intake, then finds-or-creates that contact's one conversation. Doesn't
// send a message itself; the user types and sends from the thread pane
// right after, same as any existing conversation.
router.post('/', async (req, res, next) => {
  const { name, phone, email } = req.body || {};
  const userEmail = req.user.email;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const [firstName, ...rest] = (name || '').trim().split(/\s+/).filter(Boolean);
  const lastName = rest.join(' ');

  try {
    const { contact, reused: contactReused } = await ghl.findOrCreateContact({
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      email: email || undefined,
      phone,
    });
    const { conversation, reused: convoReused } = await ghl.findOrCreateConversation({ contactId: contact.id });
    await logSync({
      userEmail,
      action: 'conversation.start',
      entityType: 'contact',
      entityId: contact.id,
      request: { name, phone, email },
      success: true,
    });
    res.status(201).json({ contact, contactReused, conversation, convoReused });
  } catch (err) {
    await logSync({
      userEmail,
      action: 'conversation.start',
      entityType: 'contact',
      request: { name, phone, email },
      success: false,
      error: err.message,
    });
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
