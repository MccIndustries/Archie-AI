const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const { listStarredIds, starConversation, unstarConversation } = require('../lib/starred');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const [conversations, starredIds] = await Promise.all([
      ghl.listConversations({ limit: 50 }),
      listStarredIds().catch(() => new Set()),
    ]);
    res.json({ conversations: conversations.map((c) => ({ ...c, starred: starredIds.has(c.id) })) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/star', async (req, res, next) => {
  try {
    await starConversation({ conversationId: req.params.id, contactId: req.body?.contactId, userEmail: req.user.email });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/star', async (req, res, next) => {
  try {
    await unstarConversation(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "+ Start Conversation" -- either picks an existing contact directly
// (contactId provided, skips contact creation entirely) or reuses the same
// find-or-create-contact pattern as intake for a brand-new one, then
// finds-or-creates that contact's one conversation. Doesn't send a message
// itself; the user types and sends from the thread pane right after, same
// as any existing conversation.
router.post('/', async (req, res, next) => {
  const { name, phone, email, contactId } = req.body || {};
  const userEmail = req.user.email;

  try {
    let contact, contactReused;
    if (contactId) {
      contact = await ghl.getContact(contactId);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      contactReused = true;
    } else {
      if (!phone) return res.status(400).json({ error: 'phone is required' });
      const [firstName, ...rest] = (name || '').trim().split(/\s+/).filter(Boolean);
      const lastName = rest.join(' ');
      ({ contact, reused: contactReused } = await ghl.findOrCreateContact({
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        email: email || undefined,
        phone,
      }));
    }
    const { conversation, reused: convoReused } = await ghl.findOrCreateConversation({ contactId: contact.id });
    await logSync({
      userEmail,
      action: 'conversation.start',
      entityType: 'contact',
      entityId: contact.id,
      request: { name, phone, email, contactId },
      success: true,
    });
    res.status(201).json({ contact, contactReused, conversation, convoReused });
  } catch (err) {
    await logSync({
      userEmail,
      action: 'conversation.start',
      entityType: 'contact',
      request: { name, phone, email, contactId },
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
