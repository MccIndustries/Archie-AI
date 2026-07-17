const express = require('express');
const ghl = require('../lib/ghlClient');
const requireAuth = require('../middleware/requireAuth');
const requireConnected = require('../middleware/requireConnected');

const router = express.Router();
router.use(requireAuth, requireConnected);

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTENTION_THRESHOLD_MS = 10 * DAY_MS;

function inRange(dateStr, from, to) {
  if (!from && !to) return true;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  if (to && t > new Date(to).getTime()) return false;
  return true;
}

async function getAppointmentsBooked({ calendarId, from, to }) {
  const calendars = await ghl.listCalendars();
  if (!calendars.length) return 0;
  const targets = calendarId ? calendars.filter((c) => c.id === calendarId) : calendars;

  // GHL's /calendars/events endpoint requires startTime/endTime as epoch
  // milliseconds -- ISO strings (what `from`/`to` are here) are silently
  // accepted but match nothing, and omitting them entirely does too. Same
  // class of bug already fixed on the Calendar tab's own appointment query.
  const startTime = (from ? new Date(from).getTime() : Date.now() - 90 * DAY_MS).toString();
  const endTime = (to ? new Date(to).getTime() : Date.now() + 365 * DAY_MS).toString();

  const lists = await Promise.all(
    targets.map((c) => ghl.listAppointments({ calendarId: c.id, startTime, endTime }))
  );
  return lists.reduce((sum, list) => sum + list.length, 0);
}

async function getUpcomingAppointments() {
  const calendars = await ghl.listCalendars();
  if (!calendars.length) return [];

  const startTime = Date.now().toString();
  const endTime = (Date.now() + 14 * DAY_MS).toString();
  const lists = await Promise.all(
    calendars.map((c) =>
      ghl.listAppointments({ calendarId: c.id, startTime, endTime }).then((events) =>
        events.map((e) => ({ ...e, calendarName: c.name }))
      )
    )
  );
  return lists
    .flat()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .slice(0, 5)
    .map((e) => ({ id: e.id, title: e.title, calendarName: e.calendarName, startTime: e.startTime }));
}

router.get('/', async (req, res, next) => {
  try {
    const { from, to, pipelineId, calendarId } = req.query;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [contactsCount, newLeadsToday, pipelines, allJobs, appointmentsBooked, upcomingAppointments] = await Promise.all([
      ghl.getContactsCount(),
      ghl.countContactsCreatedSince(startOfToday.toISOString()),
      ghl.listPipelines(),
      ghl.listJobs({}),
      getAppointmentsBooked({ calendarId, from, to }).catch(() => 0),
      getUpcomingAppointments().catch(() => []),
    ]);

    // Kept alongside each aggregate total -- lets the dashboard's KPI cards
    // open a popup with the exact jobs that made up that number, instead of
    // just showing a bare figure.
    const toSummary = (j) => ({
      id: j.id,
      customerName: j.customerName,
      carMake: j.carMake,
      carModel: j.carModel,
      value: j.value,
      stageName: j.stageName,
      status: j.status,
    });

    const revenueJobs = allJobs.filter((j) => j.status === 'won' && inRange(j.lastStatusChangeAt, from, to));
    const totalRevenue = revenueJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0);

    const pipelineValueJobs = allJobs.filter((j) => j.status === 'open' && inRange(j.createdAt, from, to));
    const pipelineValue = pipelineValueJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0);

    const monthStart = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
    const closedThisMonthJobs = allJobs.filter(
      (j) => j.status === 'won' && j.lastStatusChangeAt && new Date(j.lastStatusChangeAt) >= monthStart
    );
    const closedThisMonth = closedThisMonthJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0);

    const activeJobsList = allJobs.filter((j) => j.status === 'open');
    const activeJobsCount = activeJobsList.length;

    const now = Date.now();
    const attentionPool = pipelineId ? allJobs.filter((j) => j.pipelineId === pipelineId) : allJobs;
    const jobsNeedingAttention = attentionPool
      .filter((j) => j.status === 'open' && j.lastStageChangeAt)
      .filter((j) => now - new Date(j.lastStageChangeAt).getTime() >= ATTENTION_THRESHOLD_MS)
      .map((j) => ({
        id: j.id,
        customerName: j.customerName,
        carMake: j.carMake,
        carModel: j.carModel,
        value: j.value,
        stageName: j.stageName,
        daysInStage: Math.floor((now - new Date(j.lastStageChangeAt).getTime()) / DAY_MS),
      }))
      .sort((a, b) => b.daysInStage - a.daysInStage);

    // Stage breakdown for every pipeline (not just the default one), so the
    // dashboard gives a full-account overview without switching pipelines.
    const pipelineOverviews = pipelines.map((pipeline) => {
      const pipelineJobs = allJobs.filter((j) => j.pipelineId === pipeline.id);
      return {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        totalJobs: pipelineJobs.length,
        stageCounts: (pipeline.stages || []).map((stage) => {
          const stageJobs = pipelineJobs.filter((j) => j.stageId === stage.id);
          return {
            stageId: stage.id,
            stageName: stage.name,
            count: stageJobs.length,
            value: stageJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0),
          };
        }),
      };
    });

    res.json({
      totalContacts: contactsCount,
      newLeadsToday,
      totalRevenue,
      pipelineValue,
      closedThisMonth,
      activeJobsCount,
      appointmentsBooked,
      upcomingAppointments,
      pipelineOverviews,
      jobsNeedingAttention,
      revenueJobs: revenueJobs.map(toSummary),
      pipelineValueJobs: pipelineValueJobs.map(toSummary),
      closedThisMonthJobs: closedThisMonthJobs.map(toSummary),
      activeJobsList: activeJobsList.map(toSummary),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
