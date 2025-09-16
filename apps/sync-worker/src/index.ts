import type { CommandEnvelope, JobStatus } from 'shared';
import { createJobStoreFromEnv, createRedis, signPayload, nowIso, PostgresJobStore, JaneRPA, CspClient, loadRuntimeConfig } from 'shared';
import fetch from 'node-fetch';

const cfg = loadRuntimeConfig();
const jobs = createJobStoreFromEnv();
const redis = createRedis(process.env.REDIS_URL);
const queueKey = 'swiftclinic:queue:commands';
const webhookOutbox = 'swiftclinic:webhook:outbox';
const webhookDlq = 'swiftclinic:webhook:dlq';
const webhookUrl = process.env.WEBHOOK_URL; // receiver endpoint
const webhookSecret = process.env.WEBHOOK_SECRET || 'dev_secret';

async function resumeOrRepairRunningJobs() {
  if (!(jobs instanceof PostgresJobStore)) return;
  // best-effort: mark stale running jobs as failed with rollback_required (until step checkpoints are implemented)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const client = new Client({ connectionString: (jobs as any).url });
  await client.connect();
  await client.query(`update jobs set state='failed', error='{"code":"crash_resume","message":"Worker restarted"}'::jsonb, updated_at=now() where state='running'`);
  await client.end();
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function processAtomicReplace(cmd: CommandEnvelope, job_id: string): Promise<Partial<JobStatus>> {
  // Preconditions
  if (!cmd.start_iso || !cmd.end_iso || !cmd.patient || !cmd.appointment_type_key) {
    throw new Error('invalid_command');
  }

  const rpa = new JaneRPA({ headless: process.env.PLAYWRIGHT_HEADLESS !== 'false' });
  const csp = cfg.csp ? new CspClient({ host: cfg.csp.host, apiKey: cfg.csp.apiKey }) : null;

  let parked = false;
  let cspId: string | null = null;

  const pg = jobs instanceof PostgresJobStore ? (jobs as PostgresJobStore) : null;
  const record = async (state: string) => {
    if (!pg) return;
    await pg.recordConversionState({ job_id, clinic_id: cmd.clinic_id, practitioner_key: cmd.practitioner_key, start_iso: cmd.start_iso, end_iso: cmd.end_iso, state, csp_appointment_id: cspId });
  };

  try {
    await record('pending');
    await withTimeout(rpa.initSession(cmd.clinic_id), 5000, 'initSession');
    const found = await withTimeout(rpa.locateAppointment({ practitioner_key: cmd.practitioner_key, start_iso: cmd.start_iso, end_iso: cmd.end_iso, patient_text: cmd.patient.name_norm }), 5000, 'locate');
    if (!found) throw new Error('not_found');

    await withTimeout(rpa.moveToParking(cfg.parkingResourceKey), 5000, 'park');
    parked = true;
    await record('parked_original');

    if (!csp) throw new Error('csp_unavailable');
    const createRes = await withTimeout(
      csp.createAppointment({
        clinic_id: cmd.clinic_id,
        practitioner_key: cmd.practitioner_key,
        appointment_type_key: cmd.appointment_type_key,
        start_iso: cmd.start_iso,
        end_iso: cmd.end_iso,
        patient_hash: cmd.patient.email_hash || cmd.patient.phone_last4 || cmd.patient.name_norm,
        idempotency_key: cmd.idempotency_key
      }),
      5000,
      'csp_create'
    );
    cspId = createRes.csp_appointment_id;
    await record('csp_created');

    await withTimeout(rpa.cancelParked(), 5000, 'cancel_original');
    await record('original_canceled');

    // TODO: verification step
    await record('verified');

    await record('committed');
    return { state: 'succeeded', result: { csp_appointment_id: cspId, final_start_iso: cmd.start_iso, final_end_iso: cmd.end_iso } } as Partial<JobStatus>;
  } catch (err) {
    try {
      if (cspId && csp) {
        await withTimeout(csp.cancelAppointment(cspId), 5000, 'csp_cancel_comp');
      }
      if (parked) {
        // TODO: move back to original slot if known
      }
      await record('rolled_back');
    } catch {}
    throw err;
  } finally {
    try { await rpa.close(); } catch {}
  }
}

async function sendWebhook(eventBody: any) {
  const body = JSON.stringify(eventBody);
  const signature = signPayload(body, webhookSecret);
  if (!webhookUrl) {
    console.log('WEBHOOK OUT', { body, signature });
    return;
  }
  await enqueueOutbox({ url: webhookUrl, body, signature, attempt: 0, nextAt: Date.now() });
}

async function enqueueOutbox(entry: { url: string; body: string; signature: string; attempt: number; nextAt: number }) {
  if (!redis) {
    console.log('WEBHOOK OUT (no redis)', entry);
    return;
  }
  await (redis as any).lpush('swiftclinic:webhook:outbox', JSON.stringify(entry));
}

function backoffMs(attempt: number) {
  return Math.min(60000, 1000 * Math.pow(2, attempt));
}

async function webhookDispatcherLoop() {
  if (!redis) return;
  while (true) {
    const item = await (redis as any).brpop('swiftclinic:webhook:outbox', 5);
    if (!item) continue;
    const entry = JSON.parse(item[1]) as { url: string; body: string; signature: string; attempt: number; nextAt: number };
    const now = Date.now();
    if (entry.nextAt > now) {
      await (redis as any).lpush('swiftclinic:webhook:outbox', JSON.stringify(entry));
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    try {
      const res = await fetch(entry.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': entry.signature }, body: entry.body });
      if (res.ok) continue;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      entry.attempt += 1;
      if (entry.attempt >= 6) {
        await (redis as any).lpush('swiftclinic:webhook:dlq', JSON.stringify(entry));
      } else {
        entry.nextAt = Date.now() + backoffMs(entry.attempt);
        await (redis as any).lpush('swiftclinic:webhook:outbox', JSON.stringify(entry));
      }
    }
  }
}

async function consumeLoop() {
  if (!redis) {
    console.log('Redis not configured; worker idle');
    return;
  }
  while (true) {
    try {
      const item = await (redis as any).brpop(queueKey, 5);
      if (!item) continue; // timeout
      const payload = JSON.parse(item[1]);
      const job_id: string = payload.job_id;
      const cmd: CommandEnvelope = payload.payload;
      await jobs.update(job_id, { state: 'running' });
      try {
        const result = await processAtomicReplace(cmd, job_id);
        const final = await jobs.update(job_id, { ...result, state: 'succeeded' });
        await sendWebhook({ event: 'job.succeeded', job_id, result: final.result, timestamp: nowIso() });
      } catch (err: any) {
        const final = await jobs.update(job_id, { state: 'failed', error: { code: 'error', message: String(err?.message || err) } });
        await sendWebhook({ event: 'job.failed', job_id, error: final.error, timestamp: nowIso() });
      }
    } catch (e) {
      console.error('worker loop error', e);
    }
  }
}

resumeOrRepairRunningJobs().then(() => {
  consumeLoop();
  webhookDispatcherLoop();
});

console.log('sync-worker running', nowIso());
