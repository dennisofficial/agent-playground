import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { fromExternal } from '../../_shared/prompt-kit/message';
import { TurnRunnerService } from '../runner/turn-runner.service';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { CollectedPending, DeliveryLane, DeliveryPump } from '../stimulus/delivery-pump.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { ThreadInputService } from '../surface/thread-input.service';
import { laneFor } from '../surface/thread-registry';
import { DriverStoreService } from './driver-store.service';
import type { ThreadDriver } from './thread-driver.service';

export const LANE_SEEDER = Symbol('LANE_SEEDER');

export interface LaneSeedTarget {
  jobId: string;
  orgId: string;
  repoId: string;
  threadId: string;
}

export interface LaneSeeder {
  seedLane(
    target: LaneSeedTarget,
    message: string,
    priority?: 'now' | 'queue' | 'later',
  ): Promise<void>;
}

@Injectable()
export class BuildLaneDeliveryService implements LaneSeeder, OnApplicationBootstrap {
  private readonly logger = new Logger(BuildLaneDeliveryService.name);

  constructor(
    private readonly deliveryPump: DeliveryPump,
    private readonly stimulusStore: StimulusStoreService,
    private readonly turnRegistry: TurnRegistry,
    private readonly turnRunner: TurnRunnerService,
    private readonly driverStore: DriverStoreService,
    private readonly threadInput: ThreadInputService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async resolveThreadDriver(): Promise<ThreadDriver> {
    const { ThreadDriver } = await import('./thread-driver.service.js');
    return this.moduleRef.get(ThreadDriver, { strict: false });
  }

  onApplicationBootstrap(): void {
    this.threadInput.register('builder', {
      post: async ({ jobId, orgId, repoId, ids, author }, message) => {
        const threadId = ids[0];
        const ownerJobId = await this.driverStore.threadJobId(threadId).catch(() => null);
        if (ownerJobId !== jobId) {
          throw new Error(`postToThread: thread ${threadId} is not part of job ${jobId}`);
        }

        const current = await this.driverStore.getThread(threadId).catch(() => null);
        const halted = current?.condition === 'incomplete';
        if (halted) {
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
          const result = await threadDriver.redriveThread(jobId, threadId, message);
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
        this.logger.debug(
          `build lane ${lane}: ${collected.ids.length} pending host seed(s) held for the next Leg drain`,
        );
      },
    };
  }

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

    const steps = await this.driverStore.stepsForThread(target.threadId).catch(() => []);
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

  async pump(target: LaneSeedTarget): Promise<void> {
    await this.deliveryPump.pump(this.laneDescriptor(target));
  }
}
