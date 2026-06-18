import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;
// HTTPS GitHub only — token auth doesn't work over ssh, and the workspace layer validates the same.
const GITHUB_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+?(\.git)?$/;

export class CreateProjectDto {
  @Matches(PROJECT_ID, {
    message:
      'projectId must be lowercase alphanumeric (dot/dash/underscore allowed)',
  })
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;

  /** One-line "what this project is" for the reference catalog. */
  @IsOptional()
  @IsString()
  description?: string;

  @Matches(GITHUB_URL, {
    message: 'gitUrl must be an https://github.com/<owner>/<repo> URL',
  })
  gitUrl!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultBranch?: string;

  @IsOptional()
  @IsString()
  tokenName?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  /** null clears the blurb. */
  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @Matches(GITHUB_URL, {
    message: 'gitUrl must be an https://github.com/<owner>/<repo> URL',
  })
  gitUrl?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  defaultBranch?: string;

  /** null clears the override (back to the default token). */
  @IsOptional()
  tokenName?: string | null;
}
