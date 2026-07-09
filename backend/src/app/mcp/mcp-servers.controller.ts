import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Repository } from 'typeorm';
import { CurrentOrg, type CurrentOrgCtx } from '../org/current-org.decorator';
import { OrgMembershipGuard } from '../org/org-membership.guard';
import { OrgOwnerGuard } from '../org/org-owner.guard';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  RepoEntity,
  type McpAuthKind,
  type McpOAuthTokenAuthMethod,
  type McpSurface,
} from '../persistence/entities';
import {
  McpServerStore,
  ORG_SCOPE,
  type McpHeaderInput,
  type RedactedMcpServer,
} from './mcp-server.store';
import { McpOAuthService } from './mcp-oauth.service';
import { McpProbeService } from './mcp-probe.service';
import { SystemMcpResolver } from './system-mcp-resolver.service';
import { type SystemMcpServer } from './system-mcp-registry';

const SURFACES = ['brain', 'build', 'review'] as const;
const TOKEN_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

class McpHeaderDto implements McpHeaderInput {
  @IsString() @MinLength(1) name!: string;
  /** Empty string on a `secret` entry preserves the stored value (re-enter to change). */
  @IsString() value!: string;
  @IsOptional() @IsBoolean() secret?: boolean;
}

class McpOAuthConfigDto {
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsIn(TOKEN_AUTH_METHODS) tokenAuthMethod?: McpOAuthTokenAuthMethod;
}

class SetMcpServerDto {
  @IsIn(['http', 'sse', 'stdio']) transport!: 'http' | 'sse' | 'stdio';
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() command?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) args?: string[];
  @IsOptional() @ValidateNested({ each: true }) @Type(() => McpHeaderDto) headers?: McpHeaderDto[];
  @IsOptional() @ValidateNested({ each: true }) @Type(() => McpHeaderDto) env?: McpHeaderDto[];
  @IsOptional() @IsArray() @IsIn(SURFACES, { each: true }) surfaces?: McpSurface[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['static', 'oauth']) authKind?: McpAuthKind;
  @IsOptional() @ValidateNested() @Type(() => McpOAuthConfigDto) oauth?: McpOAuthConfigDto;
}

/**
 * `/web/orgs/:orgId/mcp-servers` — manage the org's user-defined MCP servers, in two writable tiers
 * (org-wide `scope='org'` + repo-scoped `scope=<repoId>`) plus a read-only SYSTEM tier. GET is readable by
 * any member and returns NO secret values (secret header/env slots show as `null`). All mutations are an
 * Administer action — owner only (`OrgOwnerGuard`), mirroring {@link WorkspaceSecretsController}.
 */
@Controller('web/orgs/:orgId/mcp-servers')
@UseGuards(OrgMembershipGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class McpServersController {
  constructor(
    private readonly store: McpServerStore,
    private readonly probe: McpProbeService,
    private readonly oauth: McpOAuthService,
    private readonly system: SystemMcpResolver,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
  ) {}

  @Get()
  async list(
    @CurrentOrg() org: CurrentOrgCtx,
  ): Promise<{ system: SystemMcpServer[]; servers: RedactedMcpServer[] }> {
    return {
      system: await this.system.resolveForOrg(org.id),
      servers: await this.store.list(org.id),
    };
  }

  @Put(':scope/:name')
  @UseGuards(OrgOwnerGuard)
  async set(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
    @Body() body: SetMcpServerDto,
  ): Promise<{ ok: boolean }> {
    const dbScope = await this.resolveScope(org.id, scope);
    this.assertShape(body);
    await this.store.write(org.id, dbScope, name, body);
    return { ok: true };
  }

  @Delete(':scope/:name')
  @UseGuards(OrgOwnerGuard)
  async remove(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ ok: boolean }> {
    const dbScope = await this.resolveScope(org.id, scope);
    await this.store.delete(org.id, dbScope, name);
    return { ok: true };
  }

  @Post(':scope/:name/validate')
  @UseGuards(OrgOwnerGuard)
  async validate(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ ok: boolean; discoveredTools?: string[]; error?: string }> {
    const dbScope = await this.resolveScope(org.id, scope);
    const row = await this.store.rawRow(org.id, dbScope, name);
    if (!row) throw new BadRequestException('unknown mcp server');
    // OAuth servers can't be validated with static headers — go through the SDK client + stored token.
    const result = row.auth_kind === 'oauth' ? await this.oauth.validate(row) : await this.probe.validate(row);
    await this.store.recordValidation(org.id, dbScope, name, result);
    return { ok: !result.error, ...result };
  }

  /**
   * Begin interactive OAuth consent for an `authKind='oauth'` server — returns the provider authorize URL for the
   * console to open in a popup. Owner-only (an Administer action, like every other MCP mutation). The provider
   * redirects back to the `@Public()` {@link McpOAuthCallbackController}, which completes the exchange.
   */
  @Post(':scope/:name/oauth/start')
  @UseGuards(OrgOwnerGuard)
  async oauthStart(
    @CurrentOrg() org: CurrentOrgCtx,
    @Param('scope') scope: string,
    @Param('name') name: string,
  ): Promise<{ authorizeUrl: string }> {
    const dbScope = await this.resolveScope(org.id, scope);
    return this.oauth.beginAuthorization(org.id, dbScope, name);
  }

  /** Map `'org'` → the `'*'` sentinel; otherwise require the repo to belong to this org. */
  private async resolveScope(orgId: string, scope: string): Promise<string> {
    if (scope === 'org') return ORG_SCOPE;
    const repo = await this.repos.findOne({ where: { id: scope, org_id: orgId } });
    if (!repo) throw new BadRequestException(`unknown repo scope '${scope}' for this org`);
    return scope;
  }

  /** Transport-shape guard the class-validator DTO can't express (url vs command/args mutual need). */
  private assertShape(body: SetMcpServerDto): void {
    if (body.transport === 'stdio') {
      if (!body.command) throw new BadRequestException('stdio transport requires a command');
      if (body.authKind === 'oauth') throw new BadRequestException('oauth is only supported for http/sse transports');
    } else if (!body.url) {
      throw new BadRequestException(`${body.transport} transport requires a url`);
    }
  }
}
