import authRouter from './auth.js';
import contactRouter from './contact.js';
import demoBookingRouter from './demo-booking.js';
import locationRouter from './location.js';
import locationsRouter from './locations.js';
import staffRouter from './staff.js';
import clockinRouter from './clockin.js';
import shiftsRouter from './shifts.js';
import budgetsRouter from './budgets.js';
import timeEntriesRouter from './time-entries.js';
import fraudRouter from './fraud.js';
import paymentRouter from './payment.js';
import activitiesRouter from './activities.js';
import securityRouter from './security.js';
import healthRouter from './health.js';
import paymentsRouter from './payments.js';

export function registerRoutes(app) {
  app.use('/api/health', healthRouter);
  app.use('/api/contact', contactRouter);
  app.use('/api/demo-booking', demoBookingRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/location', locationRouter);
  app.use('/api/locations', locationsRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/clockin', clockinRouter);
  app.use('/api', shiftsRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api', timeEntriesRouter);
  app.use('/api/fraud', fraudRouter);
  app.use('/api/payment', paymentRouter);
  app.use('/api/activities', activitiesRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/payments', paymentsRouter);
}
