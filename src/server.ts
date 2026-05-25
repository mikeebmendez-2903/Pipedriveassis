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
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { expiresAt: number; value: unknown }>();

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['/', '/health', '/openapi.yaml', '/mobile'].includes(req.path)) return next();
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

async function cached<T>(key: string, load: () => Promise<T>, ttlMs = CACHE_TTL_MS): Promise<T> {
  const item = cache.get(key);
  if (item && item.expiresAt > Date.now()) {
    return item.value as T;
  }

  const value = await load();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
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

function simplifyActivity(activity: any) {
  return {
    id: activity.id,
    subject: activity.subject,
    type: activity.type,
    due_date: activity.due_date,
    due_time: activity.due_time,
    done: activity.done,
    priority: activity.priority,
    deal_id: activity.deal_id,
    person_id: activity.person_id,
    org_id: activity.org_id,
    owner_id: activity.owner_id
  };
}

function simplifyDeal(deal: any) {
  return {
    id: deal.id,
    title: deal.title,
    value: deal.value,
    currency: deal.currency,
    status: deal.status,
    stage_id: deal.stage_id,
    pipeline_id: deal.pipeline_id,
    person_id: deal.person_id,
    org_id: deal.org_id,
    owner_id: deal.owner_id,
    update_time: deal.update_time,
    expected_close_date: deal.expected_close_date
  };
}

function compactActivityResponse(data: any, activities: any[]) {
  return { ...data, data: activities.map(simplifyActivity) };
}

function formatActivityForSpeech(activity: any) {
  const time = activity.due_time ? ` a las ${activity.due_time}` : '';
  return `${activity.subject || 'actividad sin titulo'}${time}`;
}

function buildTodaySpeech(today: any[], overdue: any[]) {
  if (!today.length && !overdue.length) {
    return 'No tienes actividades pendientes para hoy ni vencidas.';
  }

  const parts = [];
  if (today.length) {
    const topToday = today.slice(0, 5).map(formatActivityForSpeech).join('; ');
    parts.push(`Tienes ${today.length} actividades para hoy: ${topToday}.`);
  } else {
    parts.push('No tienes actividades programadas para hoy.');
  }

  if (overdue.length) {
    const topOverdue = overdue.slice(0, 5).map(formatActivityForSpeech).join('; ');
    parts.push(`Tambien tienes ${overdue.length} vencidas: ${topOverdue}.`);
  }

  return parts.join(' ');
}

function buildDashboardSpeech(totals: { tasks: number; overdue: number; today: number; upcoming: number; deals: number }) {
  return `Resumen ejecutivo: tienes ${totals.tasks} actividades pendientes, ${totals.overdue} vencidas, ${totals.today} para hoy, ${totals.upcoming} proximas y ${totals.deals} deals asignados.`;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTaskList(title: string, activities: any[]) {
  const rows = activities.length
    ? activities.map((activity) => `
        <li>
          <strong>${escapeHtml(activity.subject || 'Sin titulo')}</strong>
          <span>${escapeHtml(activity.due_date)}${activity.due_time ? ` · ${escapeHtml(activity.due_time)}` : ''}</span>
          <small>${escapeHtml(activity.type || 'task')} · ID ${escapeHtml(activity.id)}</small>
        </li>
      `).join('')
    : '<li class="empty">No hay actividades en esta categoria.</li>';

  return `<section><h2>${escapeHtml(title)}</h2><ul>${rows}</ul></section>`;
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

app.get('/mobile', async (req, res, next) => {
  try {
    if (SHARED_SECRET && req.query.key !== SHARED_SECRET) {
      return res.status(401).send('Unauthorized');
    }

    const userId = requireCurrentUserId();
    const activities: any = await getActivitiesByOwner(userId);
    const deals: any = await getDealsByOwner(userId);
    const items = activities.data || [];
    const overdue = items.filter(isOverdue).map(simplifyActivity);
    const today = items.filter(isToday).map(simplifyActivity);
    const upcoming = items.filter(isUpcoming).slice(0, 10).map(simplifyActivity);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pipedrive Dashboard</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f6f7f9; color: #15171a; }
    header { position: sticky; top: 0; background: #101418; color: white; padding: 16px; }
    h1 { margin: 0; font-size: 20px; }
    main { padding: 14px; max-width: 760px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat, section { background: white; border: 1px solid #e1e4e8; border-radius: 8px; }
    .stat { padding: 14px; }
    .stat strong { display: block; font-size: 24px; }
    .stat span { color: #5f6873; font-size: 13px; }
    section { margin-bottom: 14px; overflow: hidden; }
    h2 { margin: 0; padding: 12px 14px; font-size: 16px; border-bottom: 1px solid #e1e4e8; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { padding: 12px 14px; border-bottom: 1px solid #eef0f2; }
    li:last-child { border-bottom: 0; }
    li strong, li span, li small { display: block; }
    li span { margin-top: 4px; color: #3f4750; }
    li small { margin-top: 4px; color: #7a838d; }
    .empty { color: #7a838d; }
  </style>
</head>
<body>
  <header><h1>Pipedrive Dashboard</h1></header>
  <main>
    <div class="grid">
      <div class="stat"><strong>${items.length}</strong><span>Pendientes</span></div>
      <div class="stat"><strong>${overdue.length}</strong><span>Vencidas</span></div>
      <div class="stat"><strong>${today.length}</strong><span>Hoy</span></div>
      <div class="stat"><strong>${(deals.data || []).length}</strong><span>Deals</span></div>
    </div>
    ${renderTaskList('Hoy', today)}
    ${renderTaskList('Vencidas', overdue)}
    ${renderTaskList('Proximas', upcoming)}
  </main>
</body>
</html>`);
  } catch (e) { next(e); }
});

app.get('/me', async (_req, res, next) => {
  try { res.json(await getCurrentUser()); } catch (e) { next(e); }
});

app.get('/tasks/my', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json(compactActivityResponse(data, data.data || []));
  } catch (e) { next(e); }
});

app.get('/tasks/overdue', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json(compactActivityResponse(data, (data.data || []).filter(isOverdue)));
  } catch (e) { next(e); }
});

app.get('/tasks/today', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json(compactActivityResponse(data, (data.data || []).filter(isToday)));
  } catch (e) { next(e); }
});

app.get('/tasks/upcoming', async (_req, res, next) => {
  try {
    const data: any = await getActivitiesByOwner(requireCurrentUserId());
    res.json(compactActivityResponse(data, (data.data || []).filter(isUpcoming)));
  } catch (e) { next(e); }
});

app.get('/deals/my', async (_req, res, next) => {
  try {
    const data: any = await getDealsByOwner(requireCurrentUserId());
    res.json({ ...data, data: (data.data || []).map(simplifyDeal) });
  } catch (e) { next(e); }
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
        overdue: items.filter(isOverdue).map(simplifyActivity),
        today: items.filter(isToday).map(simplifyActivity),
        upcoming: items.filter(isUpcoming).slice(0, 20).map(simplifyActivity),
        deals: (deals.data || []).slice(0, 50).map(simplifyDeal)
      }
    });
  } catch (e) { next(e); }
});

app.get('/tasks', (_req, res) => res.redirect(307, '/tasks/my'));
app.get('/today', (_req, res) => res.redirect(307, '/tasks/today'));
app.get('/overdue', (_req, res) => res.redirect(307, '/tasks/overdue'));
app.get('/upcoming', (_req, res) => res.redirect(307, '/tasks/upcoming'));
app.get('/deals', (_req, res) => res.redirect(307, '/deals/my'));

app.get('/voice/today', async (_req, res, next) => {
  try {
    const userId = requireCurrentUserId();
    const data: any = await cached(`activities:${userId}`, () => getActivitiesByOwner(userId));
    const items = data.data || [];
    const today = items.filter(isToday).map(simplifyActivity);
    const overdue = items.filter(isOverdue).map(simplifyActivity);
    res.json({
      success: true,
      speech: buildTodaySpeech(today, overdue),
      data: {
        today_count: today.length,
        overdue_count: overdue.length,
        today: today.slice(0, 5),
        overdue: overdue.slice(0, 5)
      }
    });
  } catch (e) { next(e); }
});

app.get('/voice/dashboard', async (_req, res, next) => {
  try {
    const userId = requireCurrentUserId();
    const activities: any = await cached(`activities:${userId}`, () => getActivitiesByOwner(userId));
    const deals: any = await cached(`deals:${userId}`, () => getDealsByOwner(userId));
    const items = activities.data || [];
    const totals = {
      tasks: items.length,
      overdue: items.filter(isOverdue).length,
      today: items.filter(isToday).length,
      upcoming: items.filter(isUpcoming).length,
      deals: (deals.data || []).length
    };
    res.json({
      success: true,
      speech: buildDashboardSpeech(totals),
      data: { totals }
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
