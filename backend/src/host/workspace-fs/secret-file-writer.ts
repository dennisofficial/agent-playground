import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import type { MaterializedSecretFile } from '../workspace-profile/workspace-profile.service';

@Injectable()
export class SecretFileWriter {
  /**
   * Write the repo's decrypted secret files into the workspace. Paths are workspace-relative (e.g. `.env.local`)
   * per the WorkspaceSecretFile contract; any path that escapes the workspace is a misconfiguration and throws
   * rather than writing outside the sandbox. Files are 0600 so a stray token isn't world-readable on the host.
   */
  async write(workspaceDir: string, files: MaterializedSecretFile[]): Promise<void> {
    for (const file of files) {
      const dest = join(workspaceDir, normalize(file.path));
      const within = relative(workspaceDir, dest);
      if (isAbsolute(file.path) || isAbsolute(within) || within.startsWith('..')) {
        throw new Error(`secret file path escapes the workspace: ${file.path}`);
      }
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.writeFile(dest, file.value, { mode: 0o600 });
    }
  }
}
