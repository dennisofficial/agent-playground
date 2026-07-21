import { sseSnapshotList } from '@lib/realtime/sse-snapshot.util';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE, sseObservable } from '@workspace/pg-realtime/nest';
import { CreateOrgDto, UpdateOrgDto, type MemberView, type OrgSummary } from '@workspace/shared';
import type { Observable } from 'rxjs';
import type { User } from '../../_lib/database/entities/user.entity';
import { OrgService } from './org.service';

@Controller('orgs')
export class OrgController {
  constructor(
    private readonly orgs: OrgService,
    @Inject(PG_REALTIME_ENGINE) private readonly realtime: RealtimeEngine,
  ) {}

  @Post()
  create(@CurrentUser() user: User, @Body() body: CreateOrgDto): Promise<OrgSummary> {
    return this.orgs.create(user.id, body.name);
  }

  @Patch(':orgId')
  update(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body() body: UpdateOrgDto,
  ): Promise<OrgSummary> {
    return this.orgs.update(user.id, orgId, body);
  }

  @Delete(':orgId')
  async remove(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<{ ok: true }> {
    await this.orgs.remove(user.id, orgId);
    return { ok: true };
  }

  @Get(':orgId/members')
  members(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Promise<MemberView[]> {
    return this.orgs.membersOf(user.id, orgId);
  }

  /**
   * Realtime org list for the workspace shell (`streamList`). A joined feed (each org tagged with the
   * caller's role), so it's served as a change-triggered snapshot: any change to the caller's orgs or
   * memberships re-emits the full `OrgSummary[]`.
   */
  @Sse('realtime')
  streamOrgs(@CurrentUser() user: User): Observable<MessageEvent> {
    return sseSnapshotList<OrgSummary>(
      [
        () => this.realtime.openSubscription({ model: 'organizations', user }),
        () => this.realtime.openSubscription({ model: 'organization_members', user }),
      ],
      () => this.orgs.listForUser(user.id),
      (o) => o.id,
    );
  }

  /** Realtime single-org document (`streamDocument`) — live name/status/automation settings. */
  @Sse(':orgId/realtime')
  streamOrg(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'organizations', user, pk: JSON.stringify([orgId]) }),
    );
  }

  /** Realtime member list (`streamList`) — joined snapshot, re-emitted on any membership change. */
  @Sse(':orgId/members/realtime')
  streamMembers(
    @CurrentUser() user: User,
    @Param('orgId', ParseUUIDPipe) orgId: string,
  ): Observable<MessageEvent> {
    return sseSnapshotList<MemberView>(
      [
        () =>
          this.realtime.openSubscription({
            model: 'organization_members',
            user,
            filter: { orgId },
          }),
      ],
      () => this.orgs.membersOf(user.id, orgId),
      (m) => m.userId,
    );
  }
}
