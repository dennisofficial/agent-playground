import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ContainerManagerService } from '../workspaces/container-manager.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from './session-registry.port';

/**
 * The boot bridge that lets the idle reaper (`ContainerManagerService`, in `WorkspacesModule`) see session
 * activity WITHOUT a DI cycle. `SESSION_REGISTRY` lives in `SessionsModule`, which IMPORTS `WorkspacesModule`,
 * so the manager can't inject the registry — it exposes two bound hooks instead (mirroring
 * `SandboxRegistry.bindEnsurer`):
 *   - `bindOpenSessionsProbe` — the reaper's (a) "no open sessions" gate counts NON-closed sessions for a
 *     workspace through this probe;
 *   - `touch` — refreshes a workstation's last-activity stamp so the reaper's (b) idle-TTL gate stays honest.
 *
 * This service registers the probe at boot and subscribes to `onUpdate` so every session lifecycle change
 * (create / turn start / turn end / close) stamps its workstation active. Until this binds, the reaper
 * conservatively treats every workspace as having open sessions (never reaps) — so a boot-order gap can't
 * lose work.
 */
@Injectable()
export class WorkstationActivityBridge
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WorkstationActivityBridge.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly containers: ContainerManagerService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  onApplicationBootstrap(): void {
    // (a) gate: count this workspace's non-closed sessions.
    this.containers.bindOpenSessionsProbe(async (workspaceId) => {
      const open = (await this.sessions.list({ workspaceId })).filter(
        (s) => s.status !== 'closed',
      );
      return open.length;
    });
    // (b) gate: every session change stamps its workstation active (keeps the idle TTL honest).
    this.unsubscribe = this.sessions.onUpdate((s) => {
      this.containers.touch(s.workspaceId);
    });
    this.logger.log('bound the reaper open-sessions probe + session-activity touch');
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }
}
