import { EnvService } from '@core/config/env/env.service';
import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DevConsoleService, type NewThreadInput } from './dev-console.service';

/** Requires the shared `DEV_CONSOLE_TOKEN` in the `x-dev-console-token` header. Combined with the
 * module mounting only when `DEV_CONSOLE_ENABLED`, the endpoint is never reachable in prod. */
@Injectable()
export class DevConsoleGuard implements CanActivate {
  constructor(private readonly env: EnvService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.env.get('DEV_CONSOLE_TOKEN');
    if (!expected) throw new ForbiddenException('DEV_CONSOLE_TOKEN not set');
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    if (req.headers['x-dev-console-token'] !== expected)
      throw new ForbiddenException('bad dev console token');
    return true;
  }
}

@Controller('dev/console')
@UseGuards(DevConsoleGuard)
export class DevConsoleController {
  constructor(private readonly svc: DevConsoleService) {}

  /** Start a fresh Atlas thread. Body: `{ team?, project?, kind? }`. */
  @Post('threads')
  newThread(@Body() body: NewThreadInput | undefined): { channelId: string } {
    return this.svc.newThread(body ?? {});
  }

  /** Send a message as a user. Body: `{ channelId, text, authorId?, authorName? }`. */
  @Post('say')
  say(
    @Body()
    body: {
      channelId?: string;
      text?: string;
      authorId?: string;
      authorName?: string;
    },
  ): { cursor: number } {
    if (!body?.channelId || !body?.text)
      throw new BadRequestException('channelId and text are required');
    return this.svc.say({
      channelId: body.channelId,
      text: body.text,
      authorId: body.authorId,
      authorName: body.authorName,
    });
  }

  /** Poll the thread's activity since a cursor. */
  @Get('events')
  events(
    @Query('channelId') channelId: string | undefined,
    @Query('since') since: string | undefined,
  ): ReturnType<DevConsoleService['events']> {
    if (!channelId) throw new BadRequestException('channelId is required');
    return this.svc.events(channelId, Number(since ?? '0') || 0);
  }
}
