/**
 * prompt-kit / jit — the install-awareness nudge (content for the `install-awareness` JIT rule).
 *
 * Pure module, no Nest deps — mirrors `svc-nudge.ts` exactly so this same file is importable BOTH
 * in-container (the `PostToolUse` hook's cheap gate, thread 2) and host-side (`ProfileAwarenessService`,
 * this thread). The detector is a curated allowlist biased to PRECISION (decision d5): it flags Bash
 * commands that install/remove profile-relevant tooling and skips everything that merely lists, restores,
 * or updates an already-declared set (`npm ci`, `pnpm install` with no package, `--help`, `list`/`outdated`).
 */

export type InstallAction = 'add' | 'remove';
export type InstallKind = 'repo-manifest' | 'env-binary';

/** One detected install/remove — the host ledger key + the checklist's action/kind angle. */
export type InstallMatch = {
  action: InstallAction;
  kind: InstallKind;
  /** Normalized `"<ecosystem>:<name>"` ledger identity, e.g. "pnpm:eslint", "apt:doctl". */
  key: string;
  /** Short human label for what matched (parallels `svc-nudge`'s smell label) — the JIT trigger's match value. */
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

/** Splits off the current shell segment (stops at the next `&&`/`||`/`;`/`|`) and returns its first package token. */
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
    const flag = cleaned.includes('=')
      ? cleaned.slice(0, cleaned.indexOf('='))
      : cleaned;
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

/** Bootstrap installers (`curl … | sh`) have no package token — key off the piped-from URL's host instead. */
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
  /** Custom package extraction (default: first non-flag token after the match). Return null to skip (no-op verb). */
  pkg?: (rest: string, cmd: string, eco: string) => string | null;
};

// Ordered; first REGEX hit wins. When a rule's verb matches but no package token follows (a bare restore/list/
// no-op like `pnpm install`, `npm ci`, `mise install`), the whole command is skipped — it is NOT a new install.
const RULES: Rule[] = [
  // --- repo-manifest: node package managers (pnpm/npm/yarn/bun) — add/install/i, with an explicit package arg.
  // Flags (`-g`/`--global`/etc.) are skipped by `firstPackageToken`, so the global-install variant needs no
  // separate rule — `npm install -g typescript` extracts `typescript` the same way.
  {
    re: /\b(pnpm|npm|yarn|bun)\s+(?:add|install|i)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => m[1].toLowerCase(),
    label: (eco) => `${eco} add/install`,
  },
  // --- repo-manifest: one-off ad-hoc runners (npx / pnpm dlx / yarn dlx).
  {
    re: /\b(npx|pnpm\s+dlx|yarn\s+dlx)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => m[1].split(/\s+/)[0].toLowerCase(),
    label: (eco) => `${eco} dlx/npx (ad-hoc runner)`,
  },
  // --- repo-manifest: uv (checked BEFORE pip so "uv pip install x" doesn't fall through to the pip rule below).
  {
    re: /\buv\s+(?:pip\s+install|add)\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: () => 'uv',
    label: () => 'uv pip install/add',
  },
  // --- repo-manifest: pip / pipx.
  {
    re: /\bpip(3|x)?\s+install\b/,
    action: 'add',
    kind: 'repo-manifest',
    eco: (m) => (m[1] === 'x' ? 'pipx' : 'pip'),
    label: (eco) => `${eco} install`,
  },
  // --- repo-manifest: cargo / go / gem.
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
  // --- env-binary: system/tool installers.
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
  // --- remove counterparts (same ecosystems as their add rules above).
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

/**
 * Classify a Bash command as a profile-relevant tooling install/removal, or null. Curated allowlist
 * (decision d5) — biased to precision; matches ADD/INSTALL and REMOVE/UNINSTALL verbs across the node/
 * python/rust/go/ruby package managers plus the system installers (apt/brew/gcloud/asdf/mise/curl|sh/
 * wget|sh), and skips list/update-index/upgrade/help and a bare restore with no package arg. On a
 * multi-package command only the FIRST package token is kept — a multi-install still nudges once.
 */
export function detectInstallCommand(command: string): InstallMatch | null {
  const cmd = command.trim();
  if (!cmd) return null;

  for (const rule of RULES) {
    const m = rule.re.exec(cmd);
    if (!m) continue;
    const eco = rule.eco(m);
    const rest = cmd.slice(m.index + m[0].length);
    const pkg = rule.pkg
      ? rule.pkg(rest, cmd, eco)
      : firstPackageToken(rest, eco);
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

/** Truncate an echoed identifier past 120 chars, mirroring `renderSvcNudge`'s echoed-command truncation. */
function truncate(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/**
 * The Stage-1 deterministic checklist for a detected install/remove transition — two action-aware variants,
 * both scoped to the whole workspace profile (d5: repo-manifest leans skill/validation, env-binary leans
 * MCP/persistence, but neither is exclusive). Wrapped with a stable `[profile-awareness]` prefix.
 */
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
