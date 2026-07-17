import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Sse,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE, sseObservable } from '@workspace/pg-realtime/nest';
import {
  ConnectRepoDto,
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  type RepoView,
  UpdateRepoDto,
} from '@workspace/shared';
import type { Observable } from 'rxjs';
import type { User } from '../auth/entities/user.entity';
import { RepoService } from './repo.service';

@Controller('orgs/:orgId/repos')
export class RepoController {
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

  @Patch(':repoId')
  update(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @Body() body: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    return this.repos.update(user.id, orgId, repoId, body);
  }

  @Delete(':repoId')
  remove(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<DisconnectRepoResult> {
    return this.repos.remove(user.id, orgId, repoId);
  }

  @Get(':repoId/branches')
  branches(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<RepoBranches> {
    return this.repos.branches(user.id, orgId, repoId);
  }

  @Post(':repoId/revalidate')
  revalidate(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
  ): Promise<ConnectedRepo> {
    return this.repos.revalidate(user.id, orgId, repoId);
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
