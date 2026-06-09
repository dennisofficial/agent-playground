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

/**
 * Type-safe environment contract. Add a key here AND a matching Joi rule below at
 * the same time (required ⇔ non-optional field, `?:` ⇔ `.optional()`). Consumed by
 * `EnvService extends BaseEnvService<IEnvConfig>`.
 *
 * Seeded from the terminal playground's real env surface (playground/.env.example);
 * grows as the harness migrates in. DB/queue vars (POSTGRES_*, REDIS_*) get added
 * when the harness moves off local SQLite.
 */
export interface IEnvConfig {
  // System
  APP_ENV: EAppEnv;
  NODE_ENV: ENodeEnv;
  ENABLE_TIMESTAMP?: string;
  ENABLE_COLOR?: string;
  // The HTTP listen port is read directly from process.env.PORT in main.ts
  // (Cloud Run injects it per service), NOT via EnvService.

  // URLs
  BACKEND_HOST: string;
  FRONTEND_HOST: string; // admin web origin — credentialed CORS in api/main.ts

  // LLM providers
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string; // required once semantic memory (fact embeddings) is on

  // LLM knobs (harness reads these; defaults applied in code, so all optional)
  CHAT_MODEL?: string;
  CHAT_TEMPERATURE?: number;
  CHAT_MAX_TOKENS?: number;
  WORKER_ENGINE?: string;
  WORKER_MODEL?: string;
  CODEX_MODEL?: string;

  // Board / data selectors
  BOARD?: string;
  ZERO_PROJECT?: string;

  // LangSmith tracing (optional — LangChain reads these from env automatically)
  LANGSMITH_TRACING?: string;
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
}

export const envConfigValidation = Joi.object<IEnvConfig, true>({
  // System
  APP_ENV: Joi.string()
    .valid(...Object.values(EAppEnv))
    .optional()
    .default(EAppEnv.LOCAL),
  NODE_ENV: Joi.string()
    .valid(...Object.values(ENodeEnv))
    .optional()
    .default(ENodeEnv.DEV),
  ENABLE_TIMESTAMP: Joi.string().optional(),
  ENABLE_COLOR: Joi.string().optional(),

  // URLs
  BACKEND_HOST: Joi.string().uri().optional().default('http://localhost:4000'),
  FRONTEND_HOST: Joi.string().uri().optional().default('http://localhost:3000'),

  // LLM providers
  ANTHROPIC_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().optional(),

  // LLM knobs
  CHAT_MODEL: Joi.string().optional(),
  CHAT_TEMPERATURE: Joi.number().optional(),
  CHAT_MAX_TOKENS: Joi.number().optional(),
  WORKER_ENGINE: Joi.string().optional(),
  WORKER_MODEL: Joi.string().optional(),
  CODEX_MODEL: Joi.string().optional(),

  // Board / data selectors
  BOARD: Joi.string().optional(),
  ZERO_PROJECT: Joi.string().optional(),

  // LangSmith tracing
  LANGSMITH_TRACING: Joi.string().optional(),
  LANGSMITH_API_KEY: Joi.string().optional(),
  LANGSMITH_PROJECT: Joi.string().optional(),
});
