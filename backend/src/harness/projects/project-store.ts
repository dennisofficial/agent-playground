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
  team_id: string;
  project_id: string;
  display_name: string;
  description: string | null;
  git_url: string;
  default_branch: string;
  token_name: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toRecord = (r: ProjectRow): ProjectRecord => ({
  teamId: r.team_id,
  projectId: r.project_id,
  displayName: r.display_name,
  description: r.description ?? null,
  gitUrl: r.git_url,
  defaultBranch: r.default_branch,
  tokenName: r.token_name,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/** The project registry — binds (team, project id) to GitHub repos. Plain SQL (house pattern).
 * Every method is workspace-scoped: two workspaces can register the same project slug. */
export class ProjectStore {
  constructor(private readonly repo: Repository<ProjectEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<ProjectRow[]> {
    return rawRows<ProjectRow>(await this.repo.manager.query(sql, params));
  }

  async get(
    teamId: string,
    projectId: string,
  ): Promise<ProjectRecord | undefined> {
    const rows = await this.q(
      `SELECT * FROM projects WHERE team_id = $1 AND project_id = $2`,
      [teamId, projectId],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(teamId: string): Promise<ProjectRecord[]> {
    const rows = await this.q(
      `SELECT * FROM projects WHERE team_id = $1 ORDER BY project_id`,
      [teamId],
    );
    return rows.map(toRecord);
  }

  /** EVERY workspace's projects — for cross-tenant boot operations (workspace adoption). */
  async listAll(): Promise<ProjectRecord[]> {
    const rows = await this.q(
      `SELECT * FROM projects ORDER BY team_id, project_id`,
      [],
    );
    return rows.map(toRecord);
  }

  async create(input: NewProject): Promise<ProjectRecord> {
    try {
      const rows = await this.q(
        `INSERT INTO projects (team_id, project_id, display_name, description, git_url, default_branch, token_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          input.teamId,
          input.projectId,
          input.displayName,
          input.description ?? null,
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
    teamId: string,
    projectId: string,
    patch: Partial<Omit<NewProject, 'projectId' | 'teamId'>>,
  ): Promise<ProjectRecord | undefined> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const add = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.displayName !== undefined) add('display_name', patch.displayName);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.gitUrl !== undefined) add('git_url', patch.gitUrl);
    if (patch.defaultBranch !== undefined)
      add('default_branch', patch.defaultBranch);
    if (patch.tokenName !== undefined) add('token_name', patch.tokenName);
    if (sets.length === 0) return this.get(teamId, projectId);
    args.push(teamId, projectId);
    const rows = await this.q(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now()
       WHERE team_id = $${args.length - 1} AND project_id = $${args.length} RETURNING *`,
      args,
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /** How many of a workspace's projects reference a token by name — backs the token delete refusal. */
  async countReferencingToken(teamId: string, name: string): Promise<number> {
    const rows = await this.q(
      `SELECT count(*)::int AS n FROM projects WHERE team_id = $1 AND token_name = $2`,
      [teamId, name],
    );
    return Number((rows[0] as unknown as { n: number })?.n ?? 0);
  }
}
