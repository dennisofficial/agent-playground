import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '@dltech/jwt-auth/server';
import type { CreateJobResult, SendMessageResult } from '@workspace/shared';
import { CreateJobDto, SendMessageDto } from '@workspace/shared';
import type { User } from '../../generated/prisma/client';
import { JobBootstrapService } from './job-bootstrap.service';

@Controller()
export class JobBootstrapController {
  constructor(private readonly bootstrap: JobBootstrapService) {}

  @Post('jobs')
  create(@CurrentUser() user: User, @Body() dto: CreateJobDto): Promise<CreateJobResult> {
    return this.bootstrap.create(dto, user);
  }

  @Post('jobs/:jobId/messages')
  sendMessage(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: SendMessageDto,
  ): Promise<SendMessageResult> {
    return this.bootstrap.sendMessage(jobId, user, dto);
  }
}
