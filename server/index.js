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
const errorHandler = require('./middleware/errorHandler');

const app = express();
app.use(express.json());

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
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(errorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`${process.env.BRAND_NAME || 'Archie AI'} portal listening on http://localhost:${port}`);
});
