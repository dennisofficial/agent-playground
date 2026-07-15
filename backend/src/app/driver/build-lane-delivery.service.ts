import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { CollectedPending, DeliveryLane } from '../stimulus';
import { DeliveryPump, StimulusStoreService } from '../stimulus';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { TurnRunnerService } from '../runner';
import { laneFor, ThreadInputService } from '../surface';
import { fromExternal } from '@shared/prompt-kit/message';
import { DriverStoreService } from './driver-store.service';
import type { ThreadDriver } from './thread-driver.service';

/** DI token a host-seed dispatcher (`JitHostExecutor`) binds to reach the build-lane seed path without a
 *  SurfaceModule↔DriverModule cycle. Bound to {@link BuildLaneDeliveryService}. */
export const LANE_SEEDER = Symbol('LANE_SEEDER');

/** The (jobId, orgId, repoId, threadId) a build-lane seed targets. */
export interface LaneSeedTarget {
  jobId: string;
  orgId: string;
  repoId: string;
  threadId: string;
}

/** The lane-capable host-seed entry point — see {@link BuildLaneDeliveryService.seedLane}. */
export interface LaneSeeder {
  seedLane(
    target: LaneSeedTarget,
    message: string,
    priority?: 'now' | 'queue' | 'later',
  ): Promise<void>;
}

/**
 * The build lane's edge of the ONE lane-generic delivery core (`DeliveryPump`). It owns a build lane's
 * {@link DeliveryLane} descriptor + the {@link seedLane} host-seed entry point (the seed analog of the brain's
 * `enqueueChat`). A build lane rides the SAME pump as the brain: a `now` host seed steers a live steerable Leg
 * (Thread-1 generic steer, stamped delivered on the engine `input_ack`); `queue`/`later` (or `now` with no
 * live turn) stay pending and drain into the next Leg's task at kick time (the driver owns Leg cadence, so the
 * descriptor's `drainFreshTurn` is a NO-OP that leaves the batch pending — it never self-starts a turn).
 *
 * Build lanes carry BOTH kinds of producer over the one pump: HOST code calling {@link seedLane}, and now the
 * OPERATOR — a human can post into a running builder lane and it steers mid-turn (or, if the thread is halted,
 * the message becomes retry guidance that re-drives it). The operator path is registered on the shared
 * {@link ThreadInputService} seam at boot ({@link onApplicationBootstrap}), so `canPost('thread:<id>')` is true
 * whenever a builder lane is input-enabled.
 */
@Injectable()
export class BuildLaneDeliveryService
  implements LaneSeeder, OnApplicationBootstrap
{
  private readonly logger = new Logger(BuildLaneDeliveryService.name);

  constructor(
    private readonly deliveryPump: DeliveryPump,
    private readonly stimulusStore: StimulusStoreService,
    private readonly turnRegistry: TurnRegistry,
    private readonly turnRunner: TurnRunnerService,
    private readonly driverStore: DriverStoreService,
    private readonly threadInput: ThreadInputService,
    // Lazily resolved (avoiding a static module cycle: thread-driver.service.ts pulls in this file
    // transitively via jit-host-executor) — same pattern as surface/resolve-merge-approval.ts.
    private readonly moduleRef: ModuleRef,
  ) {}

  private async resolveThreadDriver(): Promise<ThreadDriver> {
    const { ThreadDriver } = await import('./thread-driver.service.js');
    return this.moduleRef.get(ThreadDriver, { strict: false });
  }

  /**
   * Register the OPERATOR transport for every builder-lane thread on the shared send seam, so a generic
   * caller (the web `/say` route) can `postToThread('thread:<id>', …)` without knowing the driver. Every
   * top-level driven thread — builder, master review, post-build, ci, direct build — resolves to the one
   * `builder` kind, so this single registration enables operator input across all of them.
   *
   * The handler first guards that the thread belongs to the posting job (never touch another job's thread on
   * a client-supplied id), then splits on halt state: a HALTED thread folds the operator's text into its
   * orientation and re-drives ({@link ThreadDriver.redriveThread}); a live/pending thread persists the
   * operator bubble on the lane and pumps — steering a live steerable Leg, else leaving the row pending for
   * the next Leg's drain (the exact {@link seedLane} delivery path, minus the host-seed framing).
   */
  onApplicationBootstrap(): void {
    this.threadInput.register('builder', {
      post: async ({ jobId, orgId, repoId, ids, author }, message) => {
        const threadId = ids[0];
        const ownerJobId = await this.driverStore
          .threadJobId(threadId)
          .catch(() => null);
        if (ownerJobId !== jobId) {
          throw new Error(
            `postToThread: thread ${threadId} is not part of job ${jobId}`,
          );
        }

        // "Not done — needs the operator": the single collapsed halt state a build thread lands in when it
        // doesn't cleanly `complete_thread` (`condition==='incomplete'`), replacing the old `halt_outcome`
        // routing flag. An operator post to such a thread re-drives it; a live/pending thread pumps instead.
        const current = await this.driverStore
          .getThread(threadId)
          .catch(() => null);
        const halted = current?.condition === 'incomplete';
        if (halted) {
          // Persist the operator's own bubble first — mirrors the live/pending branch below, so the
          // message shows up in the thread's transcript even though this branch drives it via
          // `redriveThread`'s orientation fold rather than the delivery pump.
          await this.stimulusStore.recordChatStimulus({
            orgId,
            repoId,
            jobId,
            author: author ?? { id: 'U-SYSTEM', displayName: 'System' },
            replyRoute: { surfaceId: 'web', jobRef: jobId },
            body: message,
            lane: laneFor('builder', threadId),
          });
          const threadDriver = await this.resolveThreadDriver();
          const result = await threadDriver.redriveThread(
            jobId,
            threadId,
            message,
          );
          if (!result.ok) {
            throw new Error(
              `postToThread: redrive of halted thread ${threadId} failed: ${result.reason ?? 'unknown reason'}`,
            );
          }
          return;
        }

        const target = { jobId, orgId, repoId, threadId };
        await this.stimulusStore.recordChatStimulus({
          orgId,
          repoId,
          jobId,
          author: author ?? { id: 'U-SYSTEM', displayName: 'System' },
          replyRoute: { surfaceId: 'web', jobRef: jobId },
          body: message,
          lane: laneFor('builder', threadId),
        });
        await this.deliveryPump.pump(this.laneDescriptor(target));
      },
    });
  }

  /**
   * The build lane's descriptor for {@link DeliveryPump.pump}. `resolveLiveTurn` is Thread 1's
   * `runningSteerableTurn` (excludes compaction/Codex, includes a capped Claude Leg); `steer` is the generic
   * pass-through; `renderBody` is identity (a host seed is already engine-facing prose — no operator
   * attribution framing, unlike the brain's `engineBody`); `drainFreshTurn` is a NO-OP that leaves the
   * collected rows pending for the next `kickBatchTurn` to drain (a build lane never self-starts a turn).
   */
  laneDescriptor(target: LaneSeedTarget): DeliveryLane {
    const lane = laneFor('builder', target.threadId);
    return {
      jobId: target.jobId,
      orgId: target.orgId,
      repoId: target.repoId,
      lane,
      resolveLiveTurn: () =>
        this.turnRegistry.runningSteerableTurn(target.jobId, lane),
      canSteer: () => this.turnRunner.canSteer(),
      steer: (turnId, id, body) => this.turnRunner.steer(turnId, id, body),
      renderBody: (pending) => pending.body,
      drainFreshTurn: async (collected: CollectedPending) => {
        // A build lane does NOT self-start a turn — the driver owns Leg cadence. Leave the collected rows
        // pending; they drain into the next Leg task at `kickBatchTurn` and stamp delivered on register.
        this.logger.debug(
          `build lane ${lane}: ${collected.ids.length} pending host seed(s) held for the next Leg drain`,
        );
      },
    };
  }

  /**
   * Seed a build lane with a HOST message (the seed analog of the brain's `enqueueChat`):
   *   1. persist the durable stimulus row on the lane (no operator bubble — `recordHostSeed`),
   *   2. emit the VISIBLE read-only build-lane row (System-authored, `phaseId`/`legOrdinal` tagged),
   *   3. run the pump: a live steerable Leg + `now` gets steered; otherwise the row stays pending.
   */
  async seedLane(
    target: LaneSeedTarget,
    message: string,
    priority?: 'now' | 'queue' | 'later',
  ): Promise<void> {
    const lane = laneFor('builder', target.threadId);
    const seed = await this.stimulusStore.recordHostSeed({
      orgId: target.orgId,
      repoId: target.repoId,
      jobId: target.jobId,
      lane,
      body: message,
      ...(priority ? { priority } : {}),
    });

    // The read-only build-lane analog of the operator bubble — never an operator message. Tag it to the
    // thread's current anchor step + Leg so the web slices it under the right thread node. Display-only, so a
    // thread with no step yet (never planned) simply skips the visible row; delivery still rides the pump.
    const steps = await this.driverStore
      .stepsForThread(target.threadId)
      .catch(() => []);
    // Reverse-find (steps are ordinal ASC) so this prefers the LATEST session-bearing step — the ACTIVE one —
    // not the oldest; same idiom as `DriverStoreService.resolveSessionAnchor`.
    const anchor =
      [...steps].reverse().find((s) => s.sessionId != null) ??
      steps[steps.length - 1];
    if (anchor) {
      await this.driverStore
        .recordBuildSystemChunk({
          jobId: target.jobId,
          phaseId: anchor.id,
          legOrdinal: anchor.legOrdinal ?? 1,
          kind: 'system_notice',
          text: fromExternal(message),
          chunkKey: `seed:host:${seed.id}`,
        })
        .catch((err) =>
          this.logger.warn(
            `build-lane seed row failed for thread=${target.threadId}: ${err}`,
          ),
        );
    }

    await this.deliveryPump.pump(this.laneDescriptor(target));
  }

  /**
   * Re-drive a build lane's pending host seeds without seeding a new one — the at-least-once sweep backstop
   * (driver module timer roster). A no-op when nothing is pending; steers a live steerable Leg's `now` seed,
   * otherwise leaves `queue`/`later` rows pending for the next `kickBatchTurn` drain (same as {@link seedLane}).
   */
  async pump(target: LaneSeedTarget): Promise<void> {
    await this.deliveryPump.pump(this.laneDescriptor(target));
  }
}
