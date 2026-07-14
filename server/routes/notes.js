const express = require('express');
const { logSync } = require('../lib/supabase');
const { updateNote, deleteNote } = require('../lib/notes');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.put('/:id', async (req, res, next) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const result = await updateNote(req.params.id, { body });
    if (!result) return res.status(404).json({ error: 'Note not found' });
    await logSync({
      userEmail: req.user.email,
      action: 'note.update',
      entityType: 'contact',
      entityId: result.note.contact_id,
      success: true,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const row = await deleteNote(req.params.id);
    if (!row) return res.status(404).json({ error: 'Note not found' });
    await logSync({
      userEmail: req.user.email,
      action: 'note.delete',
      entityType: 'contact',
      entityId: row.contact_id,
      success: true,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
