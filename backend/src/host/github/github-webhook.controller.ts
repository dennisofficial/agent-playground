import { EnvService } from '@core/config/env/env.service';
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '@dltech/jwt-auth/server';
import type { Request } from 'express';
import { GithubWebhookService } from './github-webhook.service';

@Public()
@Controller('webhooks/github')
export class GithubWebhookController {
  constructor(
    private readonly envService: EnvService,
    private readonly githubWebhookService: GithubWebhookService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
  ): Promise<void> {
    const rawBody = req.rawBody;
    // The raw bytes are required for a correct HMAC — a re-serialized body would not match.
    if (
      !rawBody ||
      !this.githubWebhookService.verifyGithubSignature(
        rawBody,
        signature,
        this.envService.get('GITHUB_WEBHOOK_SECRET'),
      )
    ) {
      throw new UnauthorizedException('Invalid GitHub webhook signature');
    }

    // GitHub's connectivity probe carries no repository — just acknowledge it.
    if (event === 'ping') return;

    const body = req.body as { repository?: { full_name?: string } } | undefined;
    const fullName = body?.repository?.full_name;
    if (!fullName) return; // no repo to route to (e.g. org-level event we don't handle) — drop quietly

    const routed = await this.githubWebhookService.route(fullName);
    if (!routed) throw new NotFoundException(`No connected repo for ${fullName}`);

    this.githubWebhookService.handleVerifiedEvent({
      orgId: routed.orgId,
      repoId: routed.repoId,
      eventType: event ?? 'unknown',
      payload: body,
    });
  }
}
