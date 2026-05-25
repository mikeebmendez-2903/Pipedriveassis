import { getActivitiesByOwner } from './pipedrive.js';

type Activity = {
  id?: number | string;
  subject?: string;
  due_date?: string;
  due_time?: string;
  type?: string;
  deal_id?: number | string | null;
  person_id?: number | string | null;
  org_id?: number | string | null;
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

function formatActivity(activity: Activity) {
  const due = [activity.due_date, activity.due_time].filter(Boolean).join(' ');
  return [
    `Nueva actividad asignada: ${activity.subject || 'Sin titulo'}`,
    due ? `Fecha: ${due}` : undefined,
    activity.type ? `Tipo: ${activity.type}` : undefined,
    activity.deal_id ? `Deal ID: ${activity.deal_id}` : undefined,
    activity.person_id ? `Person ID: ${activity.person_id}` : undefined,
    activity.org_id ? `Org ID: ${activity.org_id}` : undefined,
    activity.id ? `Activity ID: ${activity.id}` : undefined
  ].filter(Boolean).join('\n');
}

async function sendEmail(activity: Activity) {
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
      text: formatActivity(activity)
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend notification failed ${res.status}: ${body}`);
  }
}

async function sendWhatsapp(activity: Activity) {
  if (!twilioAccountSid || !twilioAuthToken || !whatsappFrom || !whatsappTo) return;

  const body = new URLSearchParams({
    From: whatsappFrom,
    To: whatsappTo,
    Body: formatActivity(activity)
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
  await Promise.all([
    sendEmail(activity),
    sendWhatsapp(activity)
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
