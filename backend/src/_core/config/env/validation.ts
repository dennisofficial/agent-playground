import Joi from 'joi';

export enum EAppEnv {
  LOCAL = 'local',
  STAGING = 'staging',
  PROD = 'production',
}

export enum ENodeEnv {
  DEV = 'development',
  PROD = 'production',
  TEST = 'test',
}

// @reference CLAUDE.md
export interface IEnvConfig {
  APP_ENV: EAppEnv;
  NODE_ENV: ENodeEnv;

  BACKEND_HOST: string;
  FRONTEND_HOST: string; // web origin — credentialed CORS in main.ts

  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SSL_MODE?: string; // optional: diverges by env — disable locally, verify-full in prod

  REDIS_URL?: string; // optional: unset locally → redis://127.0.0.1:6379 fallback; set in deploy

  SECRETS_ENCRYPTION_KEY: string; // AES key for secrets-at-rest (org/MCP secrets_enc columns)
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  COOKIE_DOMAIN?: string; // optional: host-only in dev (unset), scoped across subdomains in deploy

  ADMIN_SEED_EMAIL?: string; // optional: dev-only — provisions the admin on boot; unset in prod
  ADMIN_SEED_PASSWORD?: string;
}

export const envConfigValidation = Joi.object<IEnvConfig, true>({
  APP_ENV: Joi.string()
    .valid(...Object.values(EAppEnv))
    .default(EAppEnv.LOCAL),
  NODE_ENV: Joi.string()
    .valid(...Object.values(ENodeEnv))
    .default(ENodeEnv.DEV),

  BACKEND_HOST: Joi.string().uri().default('http://localhost:4000'),
  FRONTEND_HOST: Joi.string().uri().default('http://localhost:3000'),

  POSTGRES_HOST: Joi.string().required(),
  POSTGRES_PORT: Joi.number().port().default(5432),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SSL_MODE: Joi.string().valid('disable', 'require', 'verify-full').optional(),

  REDIS_URL: Joi.string().uri().optional(),

  SECRETS_ENCRYPTION_KEY: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  COOKIE_DOMAIN: Joi.string().optional(),

  ADMIN_SEED_EMAIL: Joi.string().email().optional(),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),
});
