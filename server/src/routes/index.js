import { Router } from 'express';
import { authenticate } from '../middleware/index.js';
import { router as authRouter } from './auth.js';
import { router as posRouter } from './pos.js';
import { router as stockRouter } from './stock.js';
import { router as itemsRouter } from './items.js';
import { router as usersRouter } from './users.js';
import { router as alertsRouter } from './alerts.js';
import { router as reportsRouter } from './reports.js';
import { router as settingsRouter } from './settings.js';

export const api = Router();

// default-deny: setiap rute /api/* melewati authenticate kecuali ada di PUBLIC_PATHS.
// Guard per-rute (auth()) tetap ada dan tidak bekerja dua kali karena authenticate
// langsung lewati permintaan yang sudah punya req.user.
api.use(authenticate);

api.use(itemsRouter);
api.use(stockRouter);
api.use(usersRouter);
api.use(reportsRouter);
api.use(settingsRouter);
api.use(alertsRouter);
api.use(authRouter);
api.use(posRouter);
