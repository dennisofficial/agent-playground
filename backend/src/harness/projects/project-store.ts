import { Project as ProjectEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';
import type { NewProject, ProjectRecord } from './project.types';

/** Thrown on duplicate project_id so the API edge can answer 409 instead of 500. */
export class ProjectConflictError extends Error {
  constructor(projectId: string) {
    super(`Project "${projectId}" already exists.`);
  }
}

interface ProjectRow {
  project_id: string;
  display_name: string;
  git_url: string;
  default_branch: string;
  token_name: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toRecord = (r: ProjectRow): ProjectRecord => ({
  projectId: r.project_id,
  displayName: r.display_name,
  gitUrl: r.git_url,
  defaultBranch: r.default_branch,
  tokenName: r.token_name,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/** The project registry — binds room project ids to GitHub repos. Plain SQL (house pattern). */
export class ProjectStore {
  constructor(private readonly repo: Repository<ProjectEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<ProjectRow[]> {
    return rawRows<ProjectRow>(await this.repo.manager.query(sql, params));
  }

  async get(projectId: string): Promise<ProjectRecord | undefined> {
    const rows = await this.q(`SELECT * FROM projects WHERE project_id = $1`, [projectId]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(): Promise<ProjectRecord[]> {
    const rows = await this.q(`SELECT * FROM projects ORDER BY project_id`, []);
    return rows.map(toRecord);
  }

  async create(input: NewProject): Promise<ProjectRecord> {
    try {
      const rows = await this.q(
        `INSERT INTO projects (project_id, display_name, git_url, default_branch, token_name)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          input.projectId,
          input.displayName,
          input.gitUrl,
          input.defaultBranch ?? 'main',
          input.tokenName ?? null,
        ],
      );
      return toRecord(rows[0]);
    } catch (err) {
      if (err instanceof Error && /duplicate key/i.test(err.message)) {
        throw new ProjectConflictError(input.projectId);
      }
      throw err;
    }
  }

  async update(
    projectId: string,
    patch: Partial<Omit<NewProject, 'projectId'>>,
  ): Promise<ProjectRecord | undefined> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.displayName !== undefined) add('display_name', patch.displayName);
    if (patch.gitUrl !== undefined) add('git_url', patch.gitUrl);
    if (patch.defaultBranch !== undefined) add('default_branch', patch.defaultBranch);
    if (patch.tokenName !== undefined) add('token_name', patch.tokenName);
    if (sets.length === 0) return this.get(projectId);
    args.push(projectId);
    const rows = await this.q(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE project_id = $${args.length} RETURNING *`,
      args,
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /** How many projects reference a token by name — backs the token store's delete refusal. */
  async countReferencingToken(name: string): Promise<number> {
    const rows = await this.q(
      `SELECT count(*)::int AS n FROM projects WHERE token_name = $1`,
      [name],
    );
    return Number((rows[0] as unknown as { n: number })?.n ?? 0);
  }
}
