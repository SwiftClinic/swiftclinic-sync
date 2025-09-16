import Fastify from 'fastify';
import { z } from 'zod';
import type { CommandEnvelope } from 'shared';
import { createJobStoreFromEnv, createQueueFromEnv, createRedis, PostgresJobStore } from 'shared';

const app = Fastify({ logger: true });

function buildSchemas() {
  return {
    command: z.object({
      command_type: z.enum(['convert_existing','book_new','reschedule','cancel']),
      clinic_id: z.string(),
      practitioner_key: z.string(),
      appointment_type_key: z.string().optional(),
      start_iso: z.string().optional(),
      end_iso: z.string().optional(),
      patient: z.object({ name_norm: z.string(), phone_last4: z.string().optional(), email_hash: z.string().optional() }).optional(),
      conversation_id: z.string().optional(),
      idempotency_key: z.string(),
      options: z.record(z.unknown()).optional()
    })
  };
}

const schemas = buildSchemas();
const jobs = createJobStoreFromEnv();
if (jobs instanceof PostgresJobStore) {
  // best-effort bootstrap
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  jobs.bootstrap?.();
}
const queue = createQueueFromEnv(jobs);
const redis = createRedis(process.env.REDIS_URL);

app.get('/healthz', async () => ({ ok: true }));
app.get('/metrics', async () => 'jobs_total 0');

app.post('/v1/commands', async (req, reply) => {
  const parsed = schemas.command.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const cmd = parsed.data as CommandEnvelope;

  if (redis) {
    const key = `swiftclinic:idemp:${cmd.idempotency_key}`;
    const ok = await (redis as any).set(key, '1', 'NX', 'EX', 60);
    if (!ok) return reply.code(202).send({ accepted: true, job_id: 'duplicate' });
  }

  const { job_id } = await queue.enqueue(cmd);
  return { accepted: true, job_id };
});

app.get('/v1/jobs/:id', async (req, reply) => {
  const id = (req.params as any).id as string;
  const job = await jobs.get(id);
  if (!job) return reply.code(404).send({ error: 'not_found' });
  return job;
});

app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).then(() => {
  app.log.info('sync-api listening');
});
