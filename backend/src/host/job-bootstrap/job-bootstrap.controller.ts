import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import type { CreateJobResult } from '@workspace/shared';
import { CreateJobDto } from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { JobBootstrapService } from './job-bootstrap.service';

@Controller()
export class JobBootstrapController {
  constructor(private readonly bootstrap: JobBootstrapService) {}

  @Post('jobs')
  create(@CurrentUser() user: User, @Body() dto: CreateJobDto): Promise<CreateJobResult> {
    return this.bootstrap.create(dto, user);
  }
}
