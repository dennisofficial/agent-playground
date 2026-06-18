import { CreateModule } from '@workspace/nestjs-core';
import { ClaudeEngine } from '@harness/engines/claude.engine';
import { CodexEngine } from '@harness/engines/codex.engine';
import { AGENT_TOOLS_PROVIDER } from '@harness/engines/agent-tools-provider.port';
import { SkillLoaderService } from '@harness/skills/skill-loader.service';
import { EsmModule } from '../../_lib/esm/esm.module';
import { DaemonAgentToolsProvider } from './daemon-agent-tools-provider.service';
import { DaemonEngineRegistry } from './daemon-engine.registry';

/**
 * The daemon's TRIMMED engines module — the in-container counterpart to the host `EnginesModule`
 * ([engines.module.ts](../../harness/engines/engines.module.ts)), with everything DB-backed removed:
 *  - NO `LanggraphEngine` (it pulls the Postgres checkpointer) → a langgraph-free `DaemonEngineRegistry`.
 *  - NO `LlmModule`/`MemoryModule`/`SkillsModule` (the host SkillsModule is DB-backed: EmployeeRegistry
 *    + grant stores + the boot provisioner). Instead the daemon binds its OWN DB-free tools provider.
 *
 * What it provides:
 *  - `ClaudeEngine` + `CodexEngine` — imported VERBATIM from the host (they inject only the ESM SDK
 *    tokens, the host `EnvService`, and `AGENT_TOOLS_PROVIDER`, so they're byte-identical here).
 *  - `SkillLoaderService` — VERBATIM (injects only `EnvService`); resolves SkillSources to local dirs.
 *  - `DaemonAgentToolsProvider` bound to `AGENT_TOOLS_PROVIDER` — primed per-run from host-shipped
 *    inputs (Phase 5) instead of from Postgres grants.
 *  - `DaemonEngineRegistry` — name→engine, claude/codex only.
 *
 * `EsmModule` supplies the lazy-loaded ESM SDK tokens. `EnvService` (the engines' env token) comes
 * from the global `EnvModule` composed by `DaemonModule`.
 */
@CreateModule({
  imports: [EsmModule],
  services: [
    DaemonEngineRegistry,
    ClaudeEngine,
    CodexEngine,
    SkillLoaderService,
    DaemonAgentToolsProvider,
  ],
  // The engines inject the port symbol, not the concrete class — bind it to the daemon's provider.
  chains: [
    { provide: AGENT_TOOLS_PROVIDER, useExisting: DaemonAgentToolsProvider },
  ],
})
export class DaemonEnginesModule {}
