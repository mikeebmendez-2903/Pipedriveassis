# Pipedrive Executive Assistant Backend

Backend en TypeScript para conectar un GPT, una automatizacion o un dashboard web con Pipedrive.

## Requisitos

- Node.js 20 o superior
- Token de API de Pipedrive
- Dominio de tu cuenta de Pipedrive, por ejemplo `miempresa` si tu URL es `https://miempresa.pipedrive.com`
- ID del usuario de Pipedrive que quieres usar como ejecutivo actual

## Instalacion

```bash
npm install
Copy-Item .env.example .env
```

Edita `.env`:

```env
PORT=3000
PIPEDRIVE_API_TOKEN=tu_token
PIPEDRIVE_COMPANY_DOMAIN=tuempresa
PIPEDRIVE_CURRENT_USER_ID=123456
API_SHARED_SECRET=un_secreto_largo
```

Si dejas `API_SHARED_SECRET` vacio, los endpoints no pediran Authorization. Para produccion, usalo siempre.

## Desarrollo

```bash
npm run dev
```

Prueba rapida:

```bash
curl http://localhost:3000/health
```

Con secreto:

```bash
curl -H "x-api-key: un_secreto_largo" http://localhost:3000/dashboard
```

## Produccion

```bash
npm run build
npm start
```

## Deploy en Railway

1. Sube este proyecto a GitHub. No subas `.env`; ya esta en `.gitignore`.
2. En Railway, crea un nuevo proyecto desde el repositorio de GitHub.
3. Railway detectara `railway.json` y usara:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Healthcheck: `/health`
4. Configura estas variables en Railway:

```env
PIPEDRIVE_API_TOKEN=tu_token
PIPEDRIVE_COMPANY_DOMAIN=aragon-14aa2e
PIPEDRIVE_CURRENT_USER_ID=12918496
API_SHARED_SECRET=un_secreto_largo
```

Despues del deploy, prueba:

```bash
curl https://TU-SERVICIO.up.railway.app/health
curl -H "x-api-key: TU_API_SHARED_SECRET" https://TU-SERVICIO.up.railway.app/dashboard
```

## Endpoints

- `GET /health`
- `GET /openapi.yaml`
- `GET /me`
- `GET /tasks/my`
- `GET /tasks/overdue`
- `GET /tasks/today`
- `GET /tasks/upcoming`
- `GET /deals/my`
- `GET /mentions/my`
- `GET /dashboard`
- `POST /activities`
- `PATCH /activities/:id`
- `POST /activities/:id/complete`
- `POST /notes`
- `PATCH /deals/:id`

## Notificaciones de tareas nuevas

El backend puede revisar Pipedrive cada minuto y notificar cuando aparezca una nueva actividad pendiente asignada al usuario configurado.

Activa en Railway:

```env
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_POLL_SECONDS=60
```

Para email con Resend:

```env
RESEND_API_KEY=tu_resend_api_key
NOTIFY_EMAIL_TO=tu@email.com
NOTIFY_EMAIL_FROM=Pipedrive Assistant <onboarding@resend.dev>
```

Para WhatsApp con Twilio:

```env
TWILIO_ACCOUNT_SID=tu_account_sid
TWILIO_AUTH_TOKEN=tu_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_WHATSAPP_TO=whatsapp:+1TU_NUMERO
```

Al arrancar, el watcher marca las actividades existentes como vistas para evitar enviar notificaciones viejas. Solo notifica actividades nuevas detectadas despues de iniciar.

## Uso como GPT Action

1. Despliega este backend en una URL HTTPS.
2. Importa `openapi.yaml` en el editor de Actions del GPT.
3. Configura autenticacion como API Key.
4. Usa `x-api-key` como nombre del header.
5. Usa el valor de `API_SHARED_SECRET` como API key.
