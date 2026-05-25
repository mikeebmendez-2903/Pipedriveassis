import 'dotenv/config';

const token = process.env.PIPEDRIVE_API_TOKEN;
const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;

if (!token || !domain) {
  console.warn('Missing PIPEDRIVE_API_TOKEN or PIPEDRIVE_COMPANY_DOMAIN');
}

const baseUrl = `https://${domain}.pipedrive.com`;

type Query = Record<string, string | number | boolean | undefined>;

function getConfig() {
  if (!token || !domain) {
    throw new Error('Missing PIPEDRIVE_API_TOKEN or PIPEDRIVE_COMPANY_DOMAIN');
  }
  return { token, baseUrl };
}

async function request<T>(path: string, options: RequestInit = {}, query: Query = {}): Promise<T> {
  const config = getConfig();

  const url = new URL(path, config.baseUrl);
  url.searchParams.set('api_token', config.token);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`Pipedrive API error ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

export async function getCurrentUser() {
  return request('/api/v1/users/me');
}

async function requestAllPages(path: string, query: Query = {}, maxPages = 10) {
  let cursor: string | undefined;
  const data: unknown[] = [];
  let lastBody: any = { success: true, data: [] };

  for (let page = 0; page < maxPages; page += 1) {
    const body: any = await request(path, {}, { ...query, cursor });
    lastBody = body;
    data.push(...(body.data || []));

    cursor = body.additional_data?.next_cursor || body.additional_data?.pagination?.next_cursor;
    if (!cursor) break;
  }

  return { ...lastBody, data };
}

export async function getActivitiesByOwner(ownerId: string | number) {
  return requestAllPages('/api/v2/activities', {
    owner_id: ownerId,
    done: false,
    sort_by: 'due_date',
    sort_direction: 'asc',
    limit: 100
  });
}

export async function getDealsByOwner(ownerId: string | number) {
  return request('/api/v2/deals', {}, { owner_id: ownerId, limit: 100 });
}

export async function getNotes() {
  // Notes are currently documented under API v1.
  return request('/api/v1/notes', {}, { limit: 100 });
}

export async function completeActivity(id: string | number) {
  return request(`/api/v2/activities/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ done: true })
  });
}

export async function createActivity(input: Record<string, unknown>) {
  return request('/api/v2/activities', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateActivity(id: string | number, input: Record<string, unknown>) {
  return request(`/api/v2/activities/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export async function createNote(input: Record<string, unknown>) {
  return request('/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateDeal(id: string | number, input: Record<string, unknown>) {
  return request(`/api/v2/deals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}
