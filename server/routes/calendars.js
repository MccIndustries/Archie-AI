const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

router.get('/', async (req, res, next) => {
  try {
    const calendars = await ghl.listCalendars();
    res.json({ calendars });
  } catch (err) {
    next(err);
  }
});

// Registered ahead of /:id/appointments so "appointment" is never mistaken
// for a calendar id.
router.get('/appointment/:id', async (req, res, next) => {
  try {
    const appointment = await ghl.getAppointment(req.params.id);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

// One call for the Active Jobs board's appointment icon: every appointment
// on the tenant's default calendar in a wide window, grouped client-side by
// contactId -- cheaper than a per-job-card GHL round trip.
router.get('/default/appointments', async (req, res, next) => {
  try {
    const calendarId = ghl.getDefaultCalendarId();
    const startTime = (Date.now() - 90 * 24 * 60 * 60 * 1000).toString();
    const endTime = (Date.now() + 365 * 24 * 60 * 60 * 1000).toString();
    const appointments = await ghl.listAppointments({ calendarId, startTime, endTime });
    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/appointments', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    // No date filter given -- default to a wide window (90 days back, a
    // year forward) rather than requiring the caller to pick a date, so
    // "no filter" genuinely shows everything booked around now.
    const startTime = start || (Date.now() - 90 * 24 * 60 * 60 * 1000).toString();
    const endTime = end || (Date.now() + 365 * 24 * 60 * 60 * 1000).toString();
    const appointments = await ghl.listAppointments({
      calendarId: req.params.id,
      startTime,
      endTime,
    });
    res.json({ appointments });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
