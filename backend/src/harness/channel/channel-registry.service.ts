import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Channel } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { DEFAULT_PROJECT, DEFAULT_TEAM } from '../domain/identity';
import { createMutex } from '../domain/async';

export type ChannelKind = 'channel' | 'dm' | 'group-dm';

export interface ChannelInfo {
  channelId: string;
  /** The tenant (Slack team id) that owns this room — the memory `team:` tier + credential scope. */
  teamId: string;
  kind: ChannelKind;
  /** The project/workspace this room maps to — the memory `project:` tier for turns in it. */
  project: string;
  /** Participant ids, bots and humans alike ('alex', 'dennis'). */
  members: string[];
  displayName: string;
}

/**
 * The channel registry — the source of truth for which rooms exist, what kind they are (group chat
 * vs DM), which project each maps to, and who's in them. Synchronous in-memory reads (the scheduler
 * iterates it every tick), write-behind Postgres durability, hydrated at boot — same shape as
 * ChannelService/CursorStore. Rooms register on creation (TUI `/room`, a Slack invite) or lazily on
 * first message (`ensure`).
 */
@Injectable()
export class ChannelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ChannelRegistryService.name);
  private channels = new Map<string, ChannelInfo>();
  private readonly write = createMutex();

  constructor(
    @InjectRepository(Channel) private readonly repo: Repository<Channel>,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.repo.find();
    for (const r of rows) {
      this.channels.set(r.channel_id, {
        channelId: r.channel_id,
        teamId: r.team_id ?? DEFAULT_TEAM,
        kind: r.kind as ChannelKind,
        project: r.project,
        members: r.members,
        displayName: r.display_name,
      });
    }
    if (rows.length) this.logger.log(`Hydrated ${rows.length} channel(s)`);
  }

  get(channelId: string): ChannelInfo | undefined {
    return this.channels.get(channelId);
  }

  list(): ChannelInfo[] {
    return [...this.channels.values()];
  }

  /** Register the room if it's unknown; return the (existing or new) record. Lazy registration —
   * the first message on a never-seen coordinate creates a default group-chat room. */
  ensure(info: Partial<ChannelInfo> & { channelId: string }): ChannelInfo {
    const existing = this.channels.get(info.channelId);
    if (existing) return existing;
    const full: ChannelInfo = {
      channelId: info.channelId,
      teamId: info.teamId ?? DEFAULT_TEAM,
      kind: info.kind ?? 'channel',
      project: info.project ?? DEFAULT_PROJECT,
      members: info.members ?? [],
      displayName: info.displayName ?? info.channelId,
    };
    this.channels.set(full.channelId, full);
    this.persist(full);
    this.logger.log(
      `Registered channel '${full.channelId}' (team '${full.teamId}', ${full.kind}, project '${full.project}')`,
    );
    return full;
  }

  /** Add members to a room (idempotent) — a human speaking in it, a bot invited to it. */
  addMembers(channelId: string, ids: string[]): void {
    const info = this.channels.get(channelId);
    if (!info) return;
    const next = [...new Set([...info.members, ...ids])];
    if (next.length === info.members.length) return;
    const updated = { ...info, members: next };
    this.channels.set(channelId, updated);
    this.persist(updated);
  }

  isMember(id: string, channelId: string): boolean {
    return this.channels.get(channelId)?.members.includes(id) ?? false;
  }

  /** Repoint a room's project (the memory `project:` tier AND the working repo `create_workspace`
   * clones). Used when a channel's main GitHub repo is linked during onboarding — the channel-name
   * slug it registered with is replaced by the registered project id. No-op if the room is unknown or
   * already on `projectId`. */
  setProject(channelId: string, projectId: string): void {
    const info = this.channels.get(channelId);
    if (!info || info.project === projectId) return;
    const updated = { ...info, project: projectId };
    this.channels.set(channelId, updated);
    this.persist(updated);
    this.logger.log(
      `Repointed channel '${channelId}' project '${info.project}' → '${projectId}'`,
    );
  }

  /** The project a turn in this room belongs to (memory scoping). Unknown room → default project. */
  projectOf(channelId: string): string {
    return this.channels.get(channelId)?.project ?? DEFAULT_PROJECT;
  }

  /** The tenant (Slack team id) that owns this room. Unknown room → default team (dev/TUI). */
  teamIdOf(channelId: string): string {
    return this.channels.get(channelId)?.teamId ?? DEFAULT_TEAM;
  }

  /** Group-chat semantics for identity: DMs are NOT channels (pair-scope memory surfaces). */
  isChannelKind(channelId: string): boolean {
    return (this.channels.get(channelId)?.kind ?? 'channel') !== 'dm';
  }

  /** The projects of every REAL room (not DMs) that contains ALL the given members — what a DM
   * between them may recall ("the projects we share"). */
  projectsShared(memberIds: string[]): string[] {
    const projects = this.list()
      .filter(
        (c) =>
          c.kind !== 'dm' && memberIds.every((id) => c.members.includes(id)),
      )
      .map((c) => c.project);
    return [...new Set(projects)];
  }

  /** Await all queued writes (shutdown / tests). */
  flush(): Promise<void> {
    return this.write(async () => {});
  }

  private persist(info: ChannelInfo): void {
    void this.write(() =>
      this.repo.upsert(
        {
          channel_id: info.channelId,
          team_id: info.teamId,
          kind: info.kind,
          project: info.project,
          members: info.members,
          display_name: info.displayName,
        },
        ['channel_id'],
      ),
    ).catch((err) =>
      this.logger.error(`Failed to persist channel ${info.channelId}: ${err}`),
    );
  }
}
