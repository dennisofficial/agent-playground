import { Injectable } from '@nestjs/common';

export interface SkillRow {
  name: string;
  description: string | null;
  enabled: boolean;
}

/**
 * Skills catalog (provisioning). Exported directly and injected by the sandbox — no port (one impl, no
 * cycle). SHELL: `listForRepo` returns `[]` until resolution logic lands.
 */
@Injectable()
export class SkillsService {
  async listForRepo(_orgId: string, _repoId: string): Promise<SkillRow[]> {
    return await Promise.resolve([]);
  }
}
