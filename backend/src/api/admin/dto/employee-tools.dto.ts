import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsNotEmpty,
} from 'class-validator';

/** Grant a skill to an employee (global tier). `kind` selects which fields are required:
 * git → `url` (+ optional `ref`/`subPath`); local → `path` (repo-root-relative or absolute). */
export class CreateSkillDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsIn(['git', 'local'])
  kind!: 'git' | 'local';

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  ref?: string;

  @IsOptional()
  @IsString()
  subPath?: string;

  @IsOptional()
  @IsString()
  path?: string;
}

/** Grant an MCP server to an employee (global tier). `transport` selects required fields:
 * stdio → `command` (+ optional `args`/`env`); http → `url` (+ optional `headers`). */
export class CreateMcpDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(['stdio', 'http'])
  transport!: 'stdio' | 'http';

  @IsOptional()
  @IsString()
  command?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  args?: string[];

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;
}
