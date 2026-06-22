import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EventSeverity } from '../domain';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasChannel, AtlasThread } from '../persistence/entities';
import { CHAT_SURFACE, type ChatSurface } from '../surface';

/** Inputs to announce a freshly-seeded notification thread in the channel timeline. */
export interface AnnounceEventInput {
  teamId: string;
  projectId: string;
  /** The `atlas_threads` row id the event seeded. */
  threadId: string;
  /** The gateway that produced the event (for the headline). */
  source: string;
  severity: EventSeverity;
  /** The short human-readable title derived by intake (the first line of the body). */
  title: string;
}

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  critical: ':rotating_light:',
  warning: ':warning:',
  info: ':information_source:',
};

/**
 * W6 — SURFACE ORCHESTRATION. Realizes the "main timeline = headlines, thread = job chatter" model for
 * the NOTIFICATION path: a notification ANNOUNCES a short headline in the channel TIMELINE (top-level),
 * and the announcement's `ts` becomes the thread root every further exchange (triage "I'm on it",
 * park-and-ask, the driver's plan/phase/PR-ready chatter) replies INTO.
 *
 * Why this is needed: `seedEventThread` opens the `atlas_threads` row with `surface_thread_ref: null`
 * (no announcement posted yet), so `route()` returns `threadTs: null` and every downstream post would
 * land TOP-LEVEL — the timeline would fill with job chatter. Posting the announcement here and
 * BACKFILLING `surface_thread_ref` with its ts means the brain/driver — which already resolve `route()`
 * and pass `threadTs` — start threading with ZERO changes to their code (light-touch, additive).
 *
 * Chat-origin threads need no announcement: a human's first message IS the timeline post, and the
 * bridge already sets that thread's `surface_thread_ref` to the message ts. So this is event-only.
 *
 * Best-effort: a surface that can't post (headless Slack, or agent mode with no announcement consumer)
 * leaves `surface_thread_ref` null and downstream posts fall back to top-level — never a hard failure.
 * Zero v1 imports.
 */
@Injectable()
export class SurfaceOrchestration {
  private readonly logger = new Logger(SurfaceOrchestration.name);

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(AtlasChannel, ATLAS_CONNECTION)
    private readonly channels: Repository<AtlasChannel>,
    @InjectRepository(AtlasThread, ATLAS_CONNECTION)
    private readonly threads: Repository<AtlasThread>,
  ) {}

  /**
   * Post the timeline headline for a seeded event thread and backfill the thread's `surface_thread_ref`
   * with the announcement ts. Returns the announcement ts (the thread root) or undefined when nothing
   * was posted (no channel bound / surface inert). Idempotent: if the thread already has a ref it's
   * left as-is (a redelivery / resume won't double-announce).
   */
  async announceEvent(input: AnnounceEventInput): Promise<string | undefined> {
    const thread = await this.threads.findOne({ where: { id: input.threadId } });
    if (thread?.surface_thread_ref) return thread.surface_thread_ref; // already announced

    const channel = await this.channels.findOne({
      where: { team_id: input.teamId, project_id: input.projectId },
    });
    if (!channel?.surface_channel_ref) {
      this.logger.debug(`no channel for ${input.teamId}/${input.projectId} — skipping announcement`);
      return undefined;
    }

    const headline = `${SEVERITY_EMOJI[input.severity]} *[${input.source}]* ${input.title}`;
    let ts: string | undefined;
    try {
      ts = await this.surface.post(channel.surface_channel_ref, headline, {
        teamId: channel.team_id,
        ...(thread?.surface ? { surfaceId: thread.surface } : {}),
      });
    } catch (err) {
      this.logger.warn(`announcement post failed (continuing top-level): ${err}`);
      return undefined;
    }
    if (!ts) return undefined;

    await this.threads.update({ id: input.threadId }, { surface_thread_ref: ts });
    this.logger.log(`announced event thread ${input.threadId} → ${channel.surface_channel_ref} (${ts})`);
    return ts;
  }
}
