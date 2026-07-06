import { IEnvConfig } from '@core/config/env/validation';
import { Injectable } from '@nestjs/common';
import { BaseEnvService } from '@workspace/nestjs-core';

/**
 * Type-safe env accessor. `env.get('POSTGRES_HOST')` is typed as `string`,
 * `env.get('REDIS_URL')` as `string | undefined` (it's optional), etc.
 * Provided + exported globally by `EnvModule.forRoot({ envService: EnvService })`.
 */
@Injectable()
export class EnvService extends BaseEnvService<IEnvConfig> {}
