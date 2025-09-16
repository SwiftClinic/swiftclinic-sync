# SwiftClinic Appointments Orchestrator

Monorepo with apps: sync-api (HTTP API), sync-worker (background worker), scheduler (optional), and packages/shared (types, queue/store, env, stubs).

## What it does
- Convert Jane-native bookings into CSP bookings safely (Atomic Replace).
- Provide endpoints to convert/book/reschedule/cancel and emit signed webhooks.
- Persist jobs + conversion lifecycle in Postgres; queue via Redis.

## Quick start (local)
1) Install deps
- pnpm i

2) Environment
- Copy .env.sample to .env and set:
  - DATABASE_URL, REDIS_URL
  - WEBHOOK_SECRET, optional WEBHOOK_URL
  - CLINIC_ID, CLINIC_TZ, PARKING_RESOURCE_KEY
  - JANE_AUTH_METHOD + credentials (cookies or password)
  - CSP_HOST, CSP_API_KEY (optional while stubbed)

3) Run services
- API: pnpm -w --filter sync-api dev
- Worker: pnpm -w --filter sync-worker dev (needs REDIS_URL)
- Scheduler (optional): API_BASE=http://localhost:3000 pnpm -w --filter scheduler dev

4) Use the API
- POST /v1/commands → { accepted, job_id }
- GET  /v1/jobs/:id  → job status
- GET  /healthz, /metrics

## Deploy notes
- Provide DATABASE_URL, REDIS_URL, WEBHOOK_SECRET (and WEBHOOK_URL) via your platform.
- Worker requires REDIS_URL; API can fall back to in-memory queue only for dev.

## Next milestones
- Jane Playwright RPA selectors and login/session handling
- CSP client wiring (idempotent create/cancel)
- Rate limits & observability
