import { IEnvConfig } from '@core/config/env/validation';
import { Injectable } from '@nestjs/common';
import { BaseEnvService } from '@dltech/nestjs-core';

@Injectable()
export class EnvService extends BaseEnvService<IEnvConfig> {}
