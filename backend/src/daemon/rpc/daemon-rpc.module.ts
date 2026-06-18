import { CreateModule } from '@workspace/nestjs-core';
import { DaemonEnginesModule } from '../engines/daemon-engines.module';
import { DaemonGitModule } from '../git/daemon-git.module';
import { DaemonCommandConsumer } from './daemon-command.consumer';
import { DaemonGitDispatcher } from './daemon-git.dispatcher';
import { DaemonReadinessService } from './daemon-readiness.service';
import { DaemonShutdownService } from './daemon-shutdown.service';
import { DaemonTurnService } from './daemon-turn.service';

/**
 * The daemon's Redis RPC layer (Phase 5) — the consumer loop + the two command dispatchers.
 *
 * Imports:
 *  - `DaemonEnginesModule` — for `DaemonEngineRegistry` + `DaemonAgentToolsProvider` (the turn handler).
 *  - `DaemonGitModule` — for `DaemonGitService` (the git RPC + the turn handler's cwd resolution).
 *  - The shared `RedisModule` is `@Global` (composed once in `DaemonModule`), so the `REDIS_STREAM_PORT`
 *    these providers inject is in scope without re-importing it here.
 *
 * `DaemonCommandConsumer` is `OnApplicationBootstrap` — once this module is in the daemon graph the
 * loop starts on boot and the daemon begins consuming `ws:{WORKSPACE_ID}:cmds`.
 *
 * Phase 10 adds two lifecycle services here:
 *  - `DaemonReadinessService` (`OnApplicationBootstrap`) — waits for inner Docker, then writes the
 *    durable ready marker to `ws:{WORKSPACE_ID}:ready` so the host doesn't dispatch a `docker compose`
 *    turn before dockerd is up.
 *  - `DaemonShutdownService` (`OnApplicationShutdown`) — reaps lingering engine process groups and
 *    `docker compose down`s the inner stacks under each worktree, best-effort.
 */
@CreateModule({
  imports: [DaemonEnginesModule, DaemonGitModule],
  services: [
    DaemonTurnService,
    DaemonGitDispatcher,
    DaemonCommandConsumer,
    DaemonReadinessService,
    DaemonShutdownService,
  ],
})
export class DaemonRpcModule {}
