/**
 * Env for the standalone mcp-reader process. A plain `process.env` reader (NOT `@nestjs/config` —
 * this process never boots Nest), validated eagerly so a missing required var fails fast at startup
 * rather than surfacing as a confusing runtime error on the first request.
 */
export type McpReaderSsl = 'disable' | 'verify-full';

export interface McpReaderEnv {
  port: number;
  apiKey: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: McpReaderSsl;
  };
  agentHomeRoot: string;
  reposRoot: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`mcp-reader: missing required env var ${name}`);
  return value;
}

function parseSsl(raw: string | undefined): McpReaderSsl {
  if (raw === undefined || raw === 'disable') return 'disable';
  if (raw === 'verify-full') return 'verify-full';
  throw new Error(`mcp-reader: MCP_READER_PG_SSL must be 'disable' or 'verify-full', got '${raw}'`);
}

export function loadEnv(): McpReaderEnv {
  return {
    port: Number(process.env.MCP_READER_PORT ?? 4100),
    apiKey: required('MCP_READER_API_KEY'),
    pg: {
      host: required('MCP_READER_PG_HOST'),
      port: Number(process.env.MCP_READER_PG_PORT ?? 5432),
      user: required('MCP_READER_PG_USER'),
      password: required('MCP_READER_PG_PASSWORD'),
      database: required('MCP_READER_PG_DB'),
      ssl: parseSsl(process.env.MCP_READER_PG_SSL),
    },
    agentHomeRoot: process.env.AGENT_HOME_ROOT ?? '/srv/atlas/data/agent-home',
    reposRoot: process.env.REPOS_ROOT ?? '/srv/atlas/data/repos',
  };
}
