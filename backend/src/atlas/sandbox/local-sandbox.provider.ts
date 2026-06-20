import { Injectable } from '@nestjs/common';
import type { FeatureSandbox } from '../git';
import type { SandboxAttachInput, SandboxProvider } from './sandbox-provider.port';

/**
 * The `local` SANDBOX_PROVIDER binding (default) — a no-op. Turns run in-process on the host against
 * the worktree, exactly as before the Docker layer existed. `attach` returns the sandbox unchanged
 * (no `containerId`, so the `local` ENGINE_RUNNER runs in-process), and `teardown` does nothing
 * (worktrees are left in place, as today).
 */
@Injectable()
export class LocalSandboxProvider implements SandboxProvider {
  async attach(input: SandboxAttachInput): Promise<FeatureSandbox> {
    return input.sandbox;
  }

  async teardown(): Promise<void> {
    // no-op: host-local execution leaves the worktree in place
  }
}
