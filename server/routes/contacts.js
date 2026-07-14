const express = require('express');
const ghl = require('../lib/ghlClient');
const { logSync } = require('../lib/supabase');
const { listNotesForContact, createNote } = require('../lib/notes');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const { query, limit, tags, dateFrom, dateTo } = req.query;
    const tagList = tags
      ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    if (tagList.length || dateFrom || dateTo) {
      const { contacts, total } = await ghl.searchContacts({ query, tags: tagList, dateFrom, dateTo, limit });
      return res.json({ contacts, total });
    }
    const contacts = await ghl.listContacts({ query, limit });
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});

router.get('/tags', async (req, res, next) => {
  try {
    const tags = await ghl.listTags();
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const contact = await ghl.getContact(req.params.id);
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { firstName, lastName, email, phone, tags } = req.body || {};
  try {
    const contact = await ghl.createContact({ firstName, lastName, email, phone, tags });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.create',
      entityType: 'contact',
      entityId: contact.id,
      request: req.body,
      success: true,
    });
    res.status(201).json({ contact });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.create',
      entityType: 'contact',
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const { firstName, lastName, email, phone } = req.body || {};
  try {
    const contact = await ghl.updateContact(req.params.id, { firstName, lastName, email, phone });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.update',
      entityType: 'contact',
      entityId: req.params.id,
      request: req.body,
      success: true,
    });
    res.json({ contact });
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.update',
      entityType: 'contact',
      entityId: req.params.id,
      request: req.body,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.post('/:id/tags', async (req, res, next) => {
  const { tags } = req.body || {};
  try {
    const result = await ghl.addTags(req.params.id, tags);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.add',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: true,
    });
    res.json(result);
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.add',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await ghl.deleteContact(req.params.id);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.delete',
      entityType: 'contact',
      entityId: req.params.id,
      success: true,
    });
    res.status(204).end();
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.delete',
      entityType: 'contact',
      entityId: req.params.id,
      success: false,
      error: err.message,
    });
    next(err);
  }
});

router.get('/:id/notes', async (req, res, next) => {
  try {
    const notes = await listNotesForContact(req.params.id);
    res.json({ notes });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/notes', async (req, res, next) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const { note, warning } = await createNote({ contactId: req.params.id, body, userEmail: req.user.email });
    await logSync({
      userEmail: req.user.email,
      action: 'contact.note.create',
      entityType: 'contact',
      entityId: req.params.id,
      success: true,
    });
    res.status(201).json({ note, warning });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/tags', async (req, res, next) => {
  const { tags } = req.body || {};
  try {
    const result = await ghl.removeTags(req.params.id, tags);
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.remove',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: true,
    });
    res.json(result);
  } catch (err) {
    await logSync({
      userEmail: req.user.email,
      action: 'contact.tags.remove',
      entityType: 'contact',
      entityId: req.params.id,
      request: { tags },
      success: false,
      error: err.message,
    });
    next(err);
  }
});

module.exports = router;
