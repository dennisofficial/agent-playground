import {
  Body,
  Controller,
  Get,
  Inject,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Sse,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE, sseObservable } from '@workspace/pg-realtime/nest';
import { ConnectRepoDto, type ConnectedRepo, type RepoView } from '@workspace/shared';
import type { Observable } from 'rxjs';
import type { User } from '../auth/entities/user.entity';
import { RepoService } from './repo.service';

/**
 * The org-scoped repo collection: listing and connecting are inherently in an org's context, and the
 * realtime feed is per-org. Item-level ops (identified by repoId alone) live in {@link RepoItemController}
 * at `/repos/:repoId` — they don't need the org in the path because access is tenant-scoped centrally.
 */
@Controller('orgs/:orgId/repos')
export class OrgRepoController {
  constructor(
    private readonly repos: RepoService,
    @Inject(PG_REALTIME_ENGINE) private readonly realtime: RealtimeEngine,
  ) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<RepoView[]> {
    return this.repos.list(user.id, orgId);
  }

  @Post()
  connect(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: ConnectRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.connect(user.id, orgId, body);
  }

  /**
   * Realtime repo list for an org (`streamList`). The membership guard scopes rows to the caller's
   * orgs; the `orgId` filter narrows to this org — a non-member gets an empty stream, never a leak.
   */
  @Sse('realtime')
  stream(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'repos', user, filter: { orgId } }),
    );
  }
}
