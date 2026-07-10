const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const { date, timezone } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });

    const calendarId = ghl.getDefaultCalendarId();
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Pad the window generously (a day either side) so the requested date's
    // bucket is included regardless of the gap between server time and the
    // requested timezone -- GHL buckets results by date string *in that
    // timezone*, so we just read out that key below rather than trying to
    // compute exact local-day boundaries ourselves.
    const anchor = new Date(`${date}T00:00:00Z`).getTime();
    const startDate = anchor - 24 * 60 * 60 * 1000;
    const endDate = anchor + 2 * 24 * 60 * 60 * 1000;

    const data = await ghl.getFreeSlots({ calendarId, startDate, endDate, timezone: tz });
    res.json({ slots: data[date]?.slots || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
