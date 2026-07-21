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
export type IEnvConfig = {
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

  REDIS_URL: string;

  GITHUB_APP_ID: string; // numeric App id — the JWT `iss`
  GITHUB_APP_SLUG: string; // the App's slug — install URL + `{slug}[bot]` commit identity
  GITHUB_APP_PRIVATE_KEY: string; // PEM, or base64-encoded PEM; `\n` escapes are tolerated
  GITHUB_WEBHOOK_SECRET: string; // HMAC secret shared with GitHub for inbound webhook verification

  SECRETS_ENCRYPTION_KEY: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  COOKIE_DOMAIN?: string; // optional: host-only in dev (unset), scoped across subdomains in deploy

  ADMIN_SEED_EMAIL?: string; // optional: dev-only — provisions the admin on boot; unset in prod
  ADMIN_SEED_PASSWORD?: string;

  KUBECONFIG?: string; // optional: dev-only kubeconfig path; in-cluster path is preferred when running in k8s
  K8S_CONTEXT?: string; // optional: local-only — pin the kubeconfig context (else the ambient current-context)
  SANDBOX_IMAGE: string; // the engine runtime image sandbox pods run; infra, not user/profile input
  ATLAS_DATA: string; // host root for ALL local sandbox state; bind-mounted into the k3d node (see below)
};

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

  REDIS_URL: Joi.string().uri(),

  GITHUB_APP_ID: Joi.string().required(),
  GITHUB_APP_SLUG: Joi.string().required(),
  GITHUB_APP_PRIVATE_KEY: Joi.string().required(),
  GITHUB_WEBHOOK_SECRET: Joi.string().required(),

  SECRETS_ENCRYPTION_KEY: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  COOKIE_DOMAIN: Joi.string().optional(),

  ADMIN_SEED_EMAIL: Joi.string().email().optional(),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),

  KUBECONFIG: Joi.string().optional(),
  K8S_CONTEXT: Joi.string().optional(),
  SANDBOX_IMAGE: Joi.string().default('k3d-atlas-registry:5111/atlas-sandbox:latest'),
  ATLAS_DATA: Joi.string(),
});
