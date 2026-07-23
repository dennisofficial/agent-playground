import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RealtimeResourceRegistry } from '@workspace/pg-realtime/nest-realtime';
import type { User } from '../../_lib/database/entities/user.entity';
import { OrgService } from './org.service';

@Injectable()
export class OrgRealtimeResourcesService implements OnModuleInit {
  constructor(
    private readonly registry: RealtimeResourceRegistry,
    private readonly orgs: OrgService,
  ) {}

  onModuleInit(): void {
    this.registry.register<User>('org_members', {
      triggers: (params) => [{ model: 'organization_members', filter: { orgId: params.orgId } }],
      load: async (params, principal) => {
        const orgId = params.orgId as string;
        const members = await this.orgs.membersOf(principal.id, orgId);
        return members.map((m) => ({ pk: m.userId, row: m as unknown as Record<string, unknown> }));
      },
    });

    // The operator's org list, role-joined server-side. Both organizations and organization_members
    // are RLS-scoped to the caller, so any change to either re-runs listForUser (matches the semantics
    // of the old client-side two-subscription join, without the empty-flash race).
    this.registry.register<User>('org_summary', {
      triggers: () => [{ model: 'organizations' }, { model: 'organization_members' }],
      load: async (_params, principal) => {
        const orgs = await this.orgs.listForUser(principal.id);
        return orgs.map((o) => ({ pk: o.id, row: o as unknown as Record<string, unknown> }));
      },
    });
  }
}
