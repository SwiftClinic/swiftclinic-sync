export * from './config';
export * from './rpaJane';
export * from './cspClient';
export * from './env';

export type CommandType = 'convert_existing' | 'book_new' | 'reschedule' | 'cancel';

export interface PatientRef {
  name_norm: string;
  phone_last4?: string;
  email_hash?: string;
}

export interface CommandEnvelope {
  command_type: CommandType;
  clinic_id: string;
  practitioner_key: string;
  appointment_type_key?: string;
  start_iso?: string;
  end_iso?: string;
  patient?: PatientRef;
  conversation_id?: string;
  idempotency_key: string;
  options?: Record<string, unknown>;
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface JobStatus {
  id: string;
  state: JobState;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  event: 'job.succeeded' | 'job.failed';
  job_id: string;
  conversation_id?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  timestamp: string;
}

export interface EnvConfig {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  JWT_SECRET?: string;
  WEBHOOK_SECRET: string;
  PLAYWRIGHT_HEADLESS?: string;
  CSP_HOST?: string;
  CSP_KEY?: string;
  SYNC_HORIZON_DAYS?: string;
  AUTO_SYNC?: string;
  PER_CLINIC_RATELIMIT_OPS_PER_MIN?: string;
  MAX_CONCURRENCY?: string;
}

export const requiredEnv = ['WEBHOOK_SECRET'] as const;

export function assertEnv(env: Partial<EnvConfig>): asserts env is EnvConfig {
  for (const k of requiredEnv) {
    if (!env[k]) throw new Error(`Missing required env: ${k}`);
  }
}

export interface QueueJob {
  id: string;
  payload: CommandEnvelope;
}

export interface JobStore {
  create(initial: Omit<JobStatus, 'created_at' | 'updated_at'>): Promise<JobStatus>;
  get(id: string): Promise<JobStatus | null>;
  update(id: string, patch: Partial<Omit<JobStatus, 'id'>>): Promise<JobStatus>;
}

export interface EnqueueResult { job_id: string }

export interface Queue {
  enqueue(cmd: CommandEnvelope): Promise<EnqueueResult>;
}

export function nowIso() { return new Date().toISOString(); }

// In-memory implementations for quick start
export class InMemoryJobStore implements JobStore {
  private store = new Map<string, JobStatus>();
  async create(initial: Omit<JobStatus, 'created_at'|'updated_at'>): Promise<JobStatus> {
    const now = nowIso();
    const job: JobStatus = { ...(initial as any), created_at: now, updated_at: now };
    this.store.set(job.id, job);
    return job;
  }
  async get(id: string) { return this.store.get(id) ?? null; }
  async update(id: string, patch: Partial<Omit<JobStatus,'id'>>) {
    const cur = this.store.get(id);
    if (!cur) throw new Error('not_found');
    const next: JobStatus = { ...cur, ...patch, updated_at: nowIso() } as JobStatus;
    this.store.set(id, next);
    return next;
  }
}

export class InMemoryQueue implements Queue {
  constructor(private jobs: InMemoryJobStore) {}
  async enqueue(cmd: CommandEnvelope) {
    const job_id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.jobs.create({ id: job_id, state: 'queued' });
    return { job_id };
  }
}

// Webhook signature helper (HMAC-SHA256 hex)
export function signPayload(body: string, secret: string): string {
  const crypto = lazyCrypto();
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function lazyCrypto(): typeof import('crypto') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto');
}

// Redis-backed implementations (optional)
export interface RedisLike {
  brpop: (...args: any[]) => Promise<any>;
  lpush: (...args: any[]) => Promise<any>;
  set: (...args: any[]) => Promise<any>;
  setnx: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  hset: (...args: any[]) => Promise<any>;
  hget: (...args: any[]) => Promise<any>;
}

export class RedisJobStore implements JobStore {
  constructor(private redis: RedisLike, private prefix = 'swiftclinic') {}
  private key(id: string) { return `${this.prefix}:job:${id}`; }
  async create(initial: Omit<JobStatus, 'created_at'|'updated_at'>): Promise<JobStatus> {
    const now = nowIso();
    const job: JobStatus = { ...(initial as any), created_at: now, updated_at: now };
    await this.redis.hset(this.key(job.id), 'data', JSON.stringify(job));
    return job;
  }
  async get(id: string): Promise<JobStatus | null> {
    const raw = await this.redis.hget(this.key(id), 'data');
    return raw ? JSON.parse(raw) as JobStatus : null;
  }
  async update(id: string, patch: Partial<Omit<JobStatus,'id'>>) {
    const cur = await this.get(id);
    if (!cur) throw new Error('not_found');
    const next: JobStatus = { ...cur, ...patch, updated_at: nowIso() } as JobStatus;
    await this.redis.hset(this.key(id), 'data', JSON.stringify(next));
    return next;
  }
}

export class RedisQueue implements Queue {
  constructor(private redis: RedisLike, private jobs: JobStore, private prefix = 'swiftclinic') {}
  private q() { return `${this.prefix}:queue:commands`; }
  async enqueue(cmd: CommandEnvelope) {
    const job_id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.jobs.create({ id: job_id, state: 'queued' });
    const payload = JSON.stringify({ job_id, payload: cmd });
    await this.redis.lpush(this.q(), payload);
    return { job_id };
  }
}

export function createRedis(url?: string): RedisLike | null {
  if (!url) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    return new Redis(url);
  } catch {
    return null;
  }
}

export function createJobStoreFromEnv(): JobStore {
  if (process.env.DATABASE_URL) {
    return new PostgresJobStore(process.env.DATABASE_URL);
  }
  const redis = createRedis(process.env.REDIS_URL);
  if (redis) return new RedisJobStore(redis);
  return new InMemoryJobStore();
}

export function createQueueFromEnv(jobs: JobStore): Queue {
  const redis = createRedis(process.env.REDIS_URL);
  if (redis) return new RedisQueue(redis, jobs);
  if (jobs instanceof InMemoryJobStore) return new InMemoryQueue(jobs);
  return {
    async enqueue() { throw new Error('Queue requires REDIS_URL'); }
  } as Queue;
}

// Postgres persistence (jobs + audit)
export class PostgresJobStore implements JobStore {
  private client: any;
  constructor(public url: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    this.client = new Client({ connectionString: url });
    this.client.connect();
  }
  async bootstrap() {
    await this.client.query(`
      create table if not exists jobs (
        id text primary key,
        state text not null,
        result jsonb,
        error jsonb,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create table if not exists audit_logs (
        id bigserial primary key,
        job_id text not null,
        action text not null,
        payload jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists conversions (
        id bigserial primary key,
        job_id text not null,
        clinic_id text not null,
        practitioner_key text not null,
        start_iso text,
        end_iso text,
        csp_appointment_id text,
        state text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists conversions_job_id_idx on conversions(job_id);
    `);
  }
  async recordConversionState(input: {
    job_id: string;
    clinic_id: string;
    practitioner_key: string;
    start_iso?: string;
    end_iso?: string;
    state: string;
    csp_appointment_id?: string | null;
  }) {
    await this.client.query(
      `insert into conversions(job_id, clinic_id, practitioner_key, start_iso, end_iso, csp_appointment_id, state)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [input.job_id, input.clinic_id, input.practitioner_key, input.start_iso ?? null, input.end_iso ?? null, input.csp_appointment_id ?? null, input.state]
    );
  }
  async create(initial: Omit<JobStatus, 'created_at'|'updated_at'>): Promise<JobStatus> {
    const now = nowIso();
    const job: JobStatus = { ...(initial as any), created_at: now, updated_at: now };
    await this.client.query(
      'insert into jobs(id,state,result,error,created_at,updated_at) values($1,$2,$3,$4,$5,$6)',
      [job.id, job.state, job.result ?? null, job.error ?? null, job.created_at, job.updated_at]
    );
    await this.appendAudit(job.id, 'job.created', job);
    return job;
  }
  async get(id: string): Promise<JobStatus | null> {
    const r = await this.client.query('select * from jobs where id=$1', [id]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      state: row.state,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
      created_at: row.created_at.toISOString?.() ?? row.created_at,
      updated_at: row.updated_at.toISOString?.() ?? row.updated_at
    } as JobStatus;
  }
  async update(id: string, patch: Partial<Omit<JobStatus,'id'>>) {
    const cur = await this.get(id);
    if (!cur) throw new Error('not_found');
    const next: JobStatus = { ...cur, ...patch, updated_at: nowIso() } as JobStatus;
    await this.client.query(
      'update jobs set state=$2, result=$3, error=$4, updated_at=$5 where id=$1',
      [id, next.state, next.result ?? null, next.error ?? null, next.updated_at]
    );
    await this.appendAudit(id, 'job.updated', patch);
    return next;
  }
  async appendAudit(job_id: string, action: string, payload: unknown) {
    await this.client.query(
      'insert into audit_logs(job_id, action, payload) values($1,$2,$3)',
      [job_id, action, JSON.stringify(payload)]
    );
  }
}
