import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { z } from 'zod';
import {
  getCurrentUser,
  getActivitiesByOwner,
  getDealsByOwner,
  getNotes,
  completeActivity,
  createActivity,
  updateActivity,
  createNote,
  updateDeal
} from './pipedrive.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CURRENT_USER_ID = process.env.PIPEDRIVE_CURRENT_USER_ID;
const SHARED_SECRET = process.env.API_SHARED_SECRET;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['/', '/health', '/openapi.yaml'].includes(req.path)) return next();
  if (!SHARED_SECRET) return next();
  const bearerToken = req.header('Authorization');
  const apiKey = req.header('x-api-key');
  if (apiKey !== SHARED_SECRET && bearerToken !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(requireAuth);

function requireCurrentUserId() {
  if (!CURRENT_USER_ID) {
    throw new HttpError(500, 'Missing PIPEDRIVE_CURRENT_USER_ID');
  }
  return CURRENT_USER_ID;
}

function todayISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isOverdue(activity: any) {
  return activity?.due_date && activity.due_date < todayISO() && !activity.done;
}

function isToday(activity: any) {
  return activity?.due_date === todayISO() && !activity.done;
}

function isUpcoming(activity: any) {
  return activity?.due_date && activity.due_date > todayISO() && !activity.done;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    name: 'pipedrive-assistant-backend',
    openapi: '/openapi.yaml',
    health: '/health'
  });
});

app.get('/openapi.yaml', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'openapi.yaml'));
});

app.get('/me', async (_req, res, next) => {
  try { res.json(await getCurrentUser()); } catch (e) { next(e); }
});

app.get('/tasks/my', async (_req, res, next) => {
  try { res.json(await getActivitiesByOwner(requireCurrentUserId())); } catch (e) { next(e); }
});

app.get('/tasks/overdue', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json({ ...data, data: (data.data || []).filter(isOverdue) });
  } catch (e) { next(e); }
});

app.get('/tasks/today', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json({ ...data, data: (data.data || []).filter(isToday) });
  } catch (e) { next(e); }
});

app.get('/tasks/upcoming', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json({ ...data, data: (data.data || []).filter(isUpcoming) });
  } catch (e) { next(e); }
});

app.get('/deals/my', async (_req, res, next) => {
  try { res.json(await getDealsByOwner(requireCurrentUserId())); } catch (e) { next(e); }
});

app.get('/mentions/my', async (_req, res, next) => {
  try {
    const user = await getCurrentUser() as any;
    const notes = await getNotes() as any;
    const name = user?.data?.name || '';
    const email = user?.data?.email || '';
    const mentions = (notes.data || []).filter((note: any) => {
      const content = String(note.content || '').toLowerCase();
      return (name && content.includes(name.toLowerCase())) || (email && content.includes(email.toLowerCase()));
    });
    res.json({ success: true, data: mentions });
  } catch (e) { next(e); }
});

app.get('/dashboard', async (_req, res, next) => {
  try {
    const userId = requireCurrentUserId();
    const activities: any = await getActivitiesByOwner(userId);
    const deals: any = await getDealsByOwner(userId);
    const items = activities.data || [];
    res.json({
      success: true,
      data: {
        totals: {
          tasks: items.length,
          overdue: items.filter(isOverdue).length,
          today: items.filter(isToday).length,
          upcoming: items.filter(isUpcoming).length,
          deals: (deals.data || []).length
        },
        overdue: items.filter(isOverdue),
        today: items.filter(isToday),
        upcoming: items.filter(isUpcoming).slice(0, 20),
        deals: deals.data || []
      }
    });
  } catch (e) { next(e); }
});

app.post('/activities', async (req, res, next) => {
  try {
    const schema = z.object({
      subject: z.string(),
      due_date: z.string().optional(),
      due_time: z.string().optional(),
      type: z.string().optional(),
      deal_id: z.number().optional(),
      person_id: z.number().optional(),
      org_id: z.number().optional(),
      note: z.string().optional()
    });
    res.json(await createActivity({ ...schema.parse(req.body), owner_id: Number(requireCurrentUserId()) }));
  } catch (e) { next(e); }
});

app.patch('/activities/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      subject: z.string().optional(),
      due_date: z.string().optional(),
      due_time: z.string().optional(),
      type: z.string().optional(),
      deal_id: z.number().optional(),
      person_id: z.number().optional(),
      org_id: z.number().optional(),
      note: z.string().optional(),
      done: z.boolean().optional()
    }).strict();
    res.json(await updateActivity(req.params.id, schema.parse(req.body)));
  } catch (e) { next(e); }
});

app.post('/activities/:id/complete', async (req, res, next) => {
  try { res.json(await completeActivity(req.params.id)); } catch (e) { next(e); }
});

app.post('/notes', async (req, res, next) => {
  try {
    const schema = z.object({
      content: z.string(),
      deal_id: z.number().optional(),
      person_id: z.number().optional(),
      org_id: z.number().optional()
    });
    res.json(await createNote(schema.parse(req.body)));
  } catch (e) { next(e); }
});

app.patch('/deals/:id', async (req, res, next) => {
  try {
    const schema = z.object({
      title: z.string().optional(),
      value: z.number().optional(),
      currency: z.string().optional(),
      stage_id: z.number().optional(),
      status: z.enum(['open', 'won', 'lost', 'deleted']).optional(),
      expected_close_date: z.string().optional(),
      person_id: z.number().optional(),
      org_id: z.number().optional()
    }).passthrough();
    res.json(await updateDeal(req.params.id, schema.parse(req.body)));
  } catch (e) { next(e); }
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request body', details: err.flatten() });
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Pipedrive assistant backend running on http://${HOST}:${PORT}`);
});
