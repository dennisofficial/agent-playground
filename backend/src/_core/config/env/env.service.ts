import { IEnvConfig } from '@core/config/env/validation';
import { Injectable } from '@nestjs/common';
import { BaseEnvService } from '@workspace/nestjs-core';

/**
 * Type-safe env accessor. `env.get('ANTHROPIC_API_KEY')` is typed as `string`,
 * `env.get('OPENAI_API_KEY')` as `string | undefined` (it's optional), etc.
 * Provided + exported globally by `EnvModule.forRoot({ envService: EnvService })`.
 */
@Injectable()
export class EnvService extends BaseEnvService<IEnvConfig> {}
