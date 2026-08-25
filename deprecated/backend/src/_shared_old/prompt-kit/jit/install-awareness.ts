export type InstallAction = 'add' | 'remove';
export type InstallKind = 'repo-manifest' | 'env-binary';

export type InstallMatch = {
  action: InstallAction;
  kind: InstallKind;
  key: string;
  label: string;
};

const FLAGS_WITH_VALUE_BY_ECO: Record<string, Set<string>> = {
  apt: new Set(['-o', '-t']),
  npm: new Set(['--prefix', '--registry', '--userconfig']),
  pip: new Set([
    '-c',
    '--constraint',
    '-f',
    '--find-links',
    '-i',
    '--index-url',
    '-r',
    '--requirement',
    '--target',
    '--trusted-host',
  ]),
  pipx: new Set(['--index-url', '--pip-args', '--python']),
  pnpm: new Set(['--filter', '--prefix', '--registry', '--workspace']),
  uv: new Set(['-c', '--constraint', '-r', '--requirement', '--index-url']),
  yarn: new Set(['--cwd', '--registry']),
};

function firstPackageToken(rest: string, eco: string): string | null {
  const segment = rest.split(/&&|\|\|/)[0].split(/[;|]/)[0];
  if (/\s--only-upgrade(?:\s|=|$)/.test(` ${segment}`)) return null;
  const flagsWithValue = FLAGS_WITH_VALUE_BY_ECO[eco] ?? new Set<string>();
  let skipValue = false;
  for (const tok of segment.trim().split(/\s+/).filter(Boolean)) {
    const cleaned = tok.replace(/^['"]|['"]$/g, '');
    if (!cleaned) continue;
    if (skipValue) {
      skipValue = false;
      continue;
    }
    const flag = cleaned.includes('=') ? cleaned.slice(0, cleaned.indexOf('=')) : cleaned;
    if (flagsWithValue.has(flag)) {
      skipValue = !cleaned.includes('=');
      continue;
    }
    if (
      /^-r\S+/.test(cleaned) ||
      /^--requirement=/.test(cleaned) ||
      /^--constraint=/.test(cleaned)
    ) {
      continue;
    }
    if (cleaned.startsWith('-')) continue;
    if (cleaned) return cleaned;
  }
  return null;
}

function bootstrapHost(cmd: string): string {
  const host = /https?:\/\/([^/\s'"]+)/.exec(cmd)?.[1].replace(/^www\./, '');
  return host ?? 'bootstrap';
}

type Rule = {
  re: RegExp;
  action: InstallAction;
  kind: InstallKind;
  eco: (m: RegExpExecArray) => string;
  label: (eco: string) => string;
  pkg?: (rest: string, cmd: string, eco: string) => string | null;
};

const RULES: Rule[] = [
  {
    re: /\b(pnpm|npm|yarn|bun)\s+(?:add|install|i)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => m[1].toLowerCase(),
    label: (eco) => `${eco} add/install`,
  },
  {
    re: /\b(npx|pnpm\s+dlx|yarn\s+dlx)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => m[1].split(/\s+/)[0].toLowerCase(),
    label: (eco) => `${eco} dlx/npx (ad-hoc runner)`,
  },
  {
    re: /\buv\s+(?:pip\s+install|add)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: () => 'uv',
    label: () => 'uv pip install/add',
  },
  {
    re: /\bpip(3|x)?\s+install\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => (m[1] === 'x' ? 'pipx' : 'pip'),
    label: (eco) => `${eco} install`,
  },
  {
    re: /\bcargo\s+install\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: () => 'cargo',
    label: () => 'cargo install',
  },
  {
    re: /\bgo\s+install\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: () => 'go',
    label: () => 'go install',
  },
  {
    re: /\bgem\s+install\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: () => 'gem',
    label: () => 'gem install',
  },
  {
    re: /\bapt(-get)?\s+install\b/,
    action: 'add',
    kind: 'env-binary',
    eco: () => 'apt',
    label: () => 'apt install',
  },
  {
    re: /\bbrew\s+install\b/,
    action: 'add',
    kind: 'env-binary',
    eco: () => 'brew',
    label: () => 'brew install',
  },
  {
    re: /\bgcloud\s+components\s+install\b/,
    action: 'add',
    kind: 'env-binary',
    eco: () => 'gcloud',
    label: () => 'gcloud components install',
  },
  {
    re: /\b(asdf|mise)\s+(?:plugin\s+add|install)\b/,
    action: 'add',
    kind: 'env-binary',
    eco: (m) => m[1].toLowerCase(),
    label: (eco) => `${eco} plugin add/install`,
  },
  {
    re: /\bcurl\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/,
    action: 'add',
    kind: 'env-binary',
    eco: () => 'curl',
    label: () => 'curl | sh bootstrap installer',
    pkg: (_rest, cmd) => bootstrapHost(cmd),
  },
  {
    re: /\bwget\b[^|]*\|\s*(?:sh|bash)\b/,
    action: 'add',
    kind: 'env-binary',
    eco: () => 'wget',
    label: () => 'wget | sh bootstrap installer',
    pkg: (_rest, cmd) => bootstrapHost(cmd),
  },
  {
    re: /\b(pnpm|npm|yarn|bun)\s+(?:remove|uninstall|rm)\b/,
    action: 'remove',
    kind: 'repo-manifest',
    eco: (m) => m[1].toLowerCase(),
    label: (eco) => `${eco} remove/uninstall`,
  },
  {
    re: /\bpip(3|x)?\s+uninstall\b/,
    action: 'remove',
    kind: 'repo-manifest',
    eco: (m) => (m[1] === 'x' ? 'pipx' : 'pip'),
    label: (eco) => `${eco} uninstall`,
  },
  {
    re: /\bapt(-get)?\s+(?:remove|purge)\b/,
    action: 'remove',
    kind: 'env-binary',
    eco: () => 'apt',
    label: () => 'apt remove/purge',
  },
  {
    re: /\bbrew\s+uninstall\b/,
    action: 'remove',
    kind: 'env-binary',
    eco: () => 'brew',
    label: () => 'brew uninstall',
  },
  {
    re: /\bcargo\s+uninstall\b/,
    action: 'remove',
    kind: 'repo-manifest',
    eco: () => 'cargo',
    label: () => 'cargo uninstall',
  },
  {
    re: /\bgem\s+uninstall\b/,
    action: 'remove',
    kind: 'repo-manifest',
    eco: () => 'gem',
    label: () => 'gem uninstall',
  },
  {
    re: /\bgcloud\s+components\s+remove\b/,
    action: 'remove',
    kind: 'env-binary',
    eco: () => 'gcloud',
    label: () => 'gcloud components remove',
  },
];

export function detectInstallCommand(command: string): InstallMatch | null {
  const cmd = command.trim();
  if (!cmd) return null;

  for (const rule of RULES) {
    const m = rule.re.exec(cmd);
    if (!m) continue;
    const eco = rule.eco(m);
    const rest = cmd.slice(m.index + m[0].length);
    const pkg = rule.pkg ? rule.pkg(rest, cmd, eco) : firstPackageToken(rest, eco);
    if (!pkg) return null; // verb matched but no package arg — a bare restore/list/no-op, not a new install
    return {
      action: rule.action,
      kind: rule.kind,
      key: `${eco}:${pkg}`,
      label: rule.label(eco),
    };
  }
  return null;
}

const ADDED_CORE =
  'Consider the workspace profile as a whole — is there an official/third-party SKILL that complements it ' +
  "(`propose_skill_install`)? an MCP server (`propose_mcp_servers`)? should it be part of this repo's " +
  'VALIDATION profile? does it need to PERSIST across sandbox resets (`write_setup_script`)? Only act where ' +
  'it clearly earns its place; otherwise note it and move on. NOTE: a workaround for a harness/image BUG is ' +
  "NOT profile material — file it at the image level, don't persist it.";

const RETIRE_CORE =
  'If a SKILL, MCP server, or setup-script step exists only to support it, consider retiring it ' +
  "(`propose_skill_removal` / `propose_mcp_removal` / `write_setup_script`). Only if it's genuinely orphaned; " +
  'otherwise note and move on.';

function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function renderInstallAwareness(match: InstallMatch): string {
  const key = truncate(match.key);
  if (match.action === 'remove') {
    return `[profile-awareness] You just removed \`${key}\`. ${RETIRE_CORE}`;
  }
  const lean =
    match.kind === 'repo-manifest'
      ? ' A new dependency often wants a matching SKILL or a VALIDATION profile entry.'
      : ' A new environment tool often wants an MCP server or a `write_setup_script` PERSIST step.';
  return `[profile-awareness] You just installed \`${key}\`. ${ADDED_CORE}${lean}`;
}
