require('dotenv').config();
const path = require('path');
const express = require('express');

const authRoutes = require('./routes/auth');
const contactsRoutes = require('./routes/contacts');
const jobsRoutes = require('./routes/jobs');
const pipelinesRoutes = require('./routes/pipelines');
const dashboardRoutes = require('./routes/dashboard');
const activityRoutes = require('./routes/activity');
const calendarsRoutes = require('./routes/calendars');
const intakeRoutes = require('./routes/intake');
const slotsRoutes = require('./routes/slots');
const reportsRoutes = require('./routes/reports');
const conversationsRoutes = require('./routes/conversations');
const adminRoutes = require('./routes/admin');
const notesRoutes = require('./routes/notes');
const webhooksRoutes = require('./routes/webhooks');
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(express.json());

app.use('/api/webhooks', webhooksRoutes);
app.use('/api', authRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/pipelines', pipelinesRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/calendars', calendarsRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/slots', slotsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/admin', adminRoutes);

// Clean URLs for the hand-typed/emailed pages -- the underlying files (kept
// as .html on disk for express.static's own sake) stay reachable at their
// old paths too, so links already baked into sent invite/impersonation
// emails keep working.
const PAGE_ROUTES = {
  '/login': 'login.html',
  '/admin': 'admin-login.html',
  '/admin/dashboard': 'admin.html',
  '/intake': 'intake.html',
  '/set-password': 'set-password.html',
};
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', file)));
}

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${process.env.BRAND_NAME || 'Collision Command'} portal listening on http://localhost:${port}`);
});
