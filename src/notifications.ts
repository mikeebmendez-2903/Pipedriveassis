import { getActivitiesByOwner, getActivity, getNotesByActivity } from './pipedrive.js';

type Activity = {
  id?: number | string;
  subject?: string;
  due_date?: string;
  due_time?: string;
  type?: string;
  deal_id?: number | string | null;
  person_id?: number | string | null;
  org_id?: number | string | null;
  owner_id?: number | string | null;
  creator_user_id?: number | string | null;
  add_time?: string | null;
  update_time?: string | null;
  duration?: string | null;
  done?: boolean;
  busy?: boolean;
  priority?: number | string | null;
  note?: string | null;
  location?: string | null;
  public_description?: string | null;
};

type Note = {
  id?: number | string;
  content?: string | null;
  add_time?: string | null;
  update_time?: string | null;
  user_id?: number | string | null;
};

const enabled = process.env.NOTIFICATIONS_ENABLED === 'true';
const currentUserId = process.env.PIPEDRIVE_CURRENT_USER_ID;
const intervalMs = Number(process.env.NOTIFICATIONS_POLL_SECONDS || 60) * 1000;

const resendApiKey = process.env.RESEND_API_KEY;
const emailTo = process.env.NOTIFY_EMAIL_TO;
const emailFrom = process.env.NOTIFY_EMAIL_FROM || 'Pipedrive Assistant <onboarding@resend.dev>';

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM;
const whatsappTo = process.env.TWILIO_WHATSAPP_TO;

let initialized = false;
let polling = false;
const seenActivityIds = new Set<string>();

function stripHtml(value: unknown) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|ol|ul)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function field(label: string, value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  return `${label}: ${value}`;
}

function formatNotes(notes: Note[]) {
  if (!notes.length) return 'Notas relacionadas: ninguna encontrada';

  return [
    `Notas relacionadas (${notes.length}):`,
    ...notes.map((note, index) => {
      const content = stripHtml(note.content);
      return [
        `Nota ${index + 1}${note.add_time ? ` (${note.add_time})` : ''}:`,
        content || '(sin contenido)'
      ].join('\n');
    })
  ].join('\n\n');
}

function formatActivity(activity: Activity, notes: Note[] = []) {
  const due = [activity.due_date, activity.due_time].filter(Boolean).join(' ');
  return [
    `Nueva actividad asignada: ${activity.subject || 'Sin titulo'}`,
    '',
    field('Activity ID', activity.id),
    field('Tipo', activity.type),
    field('Fecha', due),
    field('Duracion', activity.duration),
    field('Completada', activity.done),
    field('Ocupado', activity.busy),
    field('Prioridad', activity.priority),
    field('Owner ID', activity.owner_id),
    field('Creator User ID', activity.creator_user_id),
    field('Deal ID', activity.deal_id),
    field('Person ID', activity.person_id),
    field('Org ID', activity.org_id),
    field('Ubicacion', activity.location),
    field('Creada', activity.add_time),
    field('Actualizada', activity.update_time),
    '',
    activity.note ? `Nota de la actividad:\n${stripHtml(activity.note)}` : 'Nota de la actividad: ninguna',
    activity.public_description ? `Descripcion publica:\n${stripHtml(activity.public_description)}` : undefined,
    '',
    formatNotes(notes)
  ].filter((line) => line !== undefined).join('\n');
}

async function getActivityDetails(activity: Activity) {
  let detailedActivity = activity;
  let notes: Note[] = [];

  if (!activity.id) return { activity: detailedActivity, notes };

  try {
    const activityResponse: any = await getActivity(activity.id);
    detailedActivity = activityResponse.data || activity;
  } catch (error) {
    console.error(`Could not fetch activity detail for ${activity.id}`, error);
  }

  try {
    const notesResponse: any = await getNotesByActivity(activity.id);
    notes = notesResponse.data || [];
  } catch (error) {
    console.error(`Could not fetch notes for activity ${activity.id}`, error);
  }

  return { activity: detailedActivity, notes };
}

async function sendEmail(activity: Activity, notes: Note[]) {
  if (!resendApiKey || !emailTo) return;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: emailFrom,
      to: emailTo,
      subject: `Nueva tarea Pipedrive: ${activity.subject || activity.id}`,
      text: formatActivity(activity, notes)
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend notification failed ${res.status}: ${body}`);
  }
}

async function sendWhatsapp(activity: Activity, notes: Note[]) {
  if (!twilioAccountSid || !twilioAuthToken || !whatsappFrom || !whatsappTo) return;

  const body = new URLSearchParams({
    From: whatsappFrom,
    To: whatsappTo,
    Body: formatActivity(activity, notes).slice(0, 1500)
  });

  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '');
    throw new Error(`Twilio notification failed ${res.status}: ${responseBody}`);
  }
}

async function notify(activity: Activity) {
  const details = await getActivityDetails(activity);
  await Promise.all([
    sendEmail(details.activity, details.notes),
    sendWhatsapp(details.activity, details.notes)
  ]);
}

async function pollNewActivities() {
  if (!currentUserId || polling) return;
  polling = true;

  try {
    const response: any = await getActivitiesByOwner(currentUserId);
    const activities: Activity[] = response.data || [];

    if (!initialized) {
      for (const activity of activities) {
        if (activity.id) seenActivityIds.add(String(activity.id));
      }
      initialized = true;
      console.log(`Notification watcher initialized with ${seenActivityIds.size} existing activities`);
      return;
    }

    const newActivities = activities.filter((activity) => {
      if (!activity.id) return false;
      return !seenActivityIds.has(String(activity.id));
    });

    for (const activity of newActivities) {
      if (!activity.id) continue;
      seenActivityIds.add(String(activity.id));
      await notify(activity);
      console.log(`Notification sent for activity ${activity.id}`);
    }
  } catch (error) {
    console.error('Notification watcher error', error);
  } finally {
    polling = false;
  }
}

export function startNotificationWatcher() {
  if (!enabled) {
    console.log('Notification watcher disabled');
    return;
  }

  if (!currentUserId) {
    console.warn('Notification watcher disabled: missing PIPEDRIVE_CURRENT_USER_ID');
    return;
  }

  if (!resendApiKey && !twilioAccountSid) {
    console.warn('Notification watcher disabled: configure email or WhatsApp credentials');
    return;
  }

  void pollNewActivities();
  setInterval(() => void pollNewActivities(), intervalMs);
  console.log(`Notification watcher enabled every ${intervalMs / 1000}s`);
}
