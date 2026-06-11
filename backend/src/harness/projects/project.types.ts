/** A registered project: binds a project id (the slug rooms carry) to a GitHub repo. */
export interface ProjectRecord {
  /** The tenant (Slack team id) this project belongs to. */
  teamId: string;
  projectId: string;
  displayName: string;
  /** HTTPS GitHub URL (validated at the API edge). */
  gitUrl: string;
  /** The PR base branch. */
  defaultBranch: string;
  /** Named token override; null → the default token. */
  tokenName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProject {
  teamId: string;
  projectId: string;
  displayName: string;
  gitUrl: string;
  defaultBranch?: string;
  tokenName?: string | null;
}

/** Token METADATA — the only shape that ever leaves the store besides `resolve()`. */
export interface GithubTokenMeta {
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
