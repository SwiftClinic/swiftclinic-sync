export interface RuntimeConfig {
  clinicId: string;
  clinicTz: string;
  parkingResourceKey: string;
  janeAuth: { method: 'cookies' | 'password'; cookieBlobPath?: string; username?: string; password?: string };
  csp: { host: string; apiKey: string } | null;
  infra: { databaseUrl?: string; redisUrl?: string };
  webhook: { url?: string; secret: string };
  features: { autoSync: boolean; horizonDays: number; maxOpsPerMin: number; maxConcurrency: number };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const env = process.env;
  const method = (env.JANE_AUTH_METHOD === 'password' ? 'password' : 'cookies') as 'cookies' | 'password';
  const cspApiKey = env.CSP_API_KEY || env.CSP_KEY || '';
  return {
    clinicId: env.CLINIC_ID || 'clinic_1',
    clinicTz: env.CLINIC_TZ || 'UTC',
    parkingResourceKey: env.PARKING_RESOURCE_KEY || 'PARKING',
    janeAuth: {
      method,
      cookieBlobPath: env.JANE_COOKIE_BLOB_PATH,
      username: env.JANE_USERNAME,
      password: env.JANE_PASSWORD
    },
    csp: env.CSP_HOST && cspApiKey ? { host: env.CSP_HOST, apiKey: cspApiKey } : null,
    infra: { databaseUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL },
    webhook: { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET || 'dev_secret' },
    features: {
      autoSync: env.AUTO_SYNC === 'true',
      horizonDays: Number(env.SYNC_HORIZON_DAYS || 14),
      maxOpsPerMin: Number(env.PER_CLINIC_RATELIMIT_OPS_PER_MIN || 6),
      maxConcurrency: Number(env.MAX_CONCURRENCY || 2)
    }
  };
}
