import dotenv from 'dotenv';
import { z } from 'zod';

// Outside production the project's .env wins over stray shell exports: this
// machine exports PORT=0 from a shell profile, which would otherwise shadow
// .env and start the server on a random port. In production the real
// environment always wins and a stray .env file can never override it.
dotenv.config({
  override: process.env.NODE_ENV !== 'production',
  quiet: true,
});

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Deliberately absent from .env so it survives the override above; lets the
  // test runner mute logs without editing committed config.
  LOG_SILENT: booleanish.default(false),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: booleanish.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  // Shared secret the admin console (Next server) sends on every console call.
  // Unset = console endpoints refuse all requests.
  CONSOLE_API_KEY: z.string().min(32, 'CONSOLE_API_KEY must be at least 32 characters').optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_SILENT ? 'silent' : env.LOG_LEVEL,
  db: {
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
    max: env.DATABASE_POOL_MAX,
  },
  consoleApiKey: env.CONSOLE_API_KEY ?? null,
};

export default config;
