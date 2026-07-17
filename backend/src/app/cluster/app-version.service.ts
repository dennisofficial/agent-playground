import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppVersionService {
  readonly sha: string;

  constructor(env: EnvService) {
    this.sha = env.get('GIT_SHA')?.trim() || 'dev';
  }
}
