import { Injectable, Logger } from '@nestjs/common';
import type { CollectedPending, DeliveryLane } from '../stimulus';
import { DeliveryPump, StimulusStoreService } from '../stimulus';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { TurnRunnerService } from '../runner';
import { laneFor } from '../surface';
import { fromExternal } from '../prompt-kit/message';
import { DriverStoreService } from './driver-store.service';

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
 * Build lanes stay operator-read-only (d1): producers are HOST code calling {@link seedLane}; there is no
 * operator surface and `canPost('thread:<id>')` stays false.
 */
@Injectable()
export class BuildLaneDeliveryService implements LaneSeeder {
  private readonly logger = new Logger(BuildLaneDeliveryService.name);

  constructor(
    private readonly deliveryPump: DeliveryPump,
    private readonly stimulusStore: StimulusStoreService,
    private readonly turnRegistry: TurnRegistry,
    private readonly turnRunner: TurnRunnerService,
    private readonly driverStore: DriverStoreService,
  ) {}

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
      resolveLiveTurn: () => this.turnRegistry.runningSteerableTurn(target.jobId, lane),
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
    const steps = await this.driverStore.stepsForThread(target.threadId).catch(() => []);
    // Reverse-find (steps are ordinal ASC) so this prefers the LATEST session-bearing step — the ACTIVE one —
    // not the oldest; same idiom as `DriverStoreService.resolveSessionAnchor`.
    const anchor = [...steps].reverse().find((s) => s.sessionId != null) ?? steps[steps.length - 1];
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
          this.logger.warn(`build-lane seed row failed for thread=${target.threadId}: ${err}`),
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
