/**
 * prompt-kit / jit — the install-awareness detector + render table (Stage 1, decision d5).
 */
import { describe, expect, it } from 'vitest';
import { detectInstallCommand, renderInstallAwareness } from './install-awareness';

describe('detectInstallCommand — add verbs', () => {
  it.each([
    ['pnpm add eslint', 'pnpm:eslint', 'repo-manifest'],
    ['npm install eslint', 'npm:eslint', 'repo-manifest'],
    ['npm i eslint', 'npm:eslint', 'repo-manifest'],
    ['yarn add eslint', 'yarn:eslint', 'repo-manifest'],
    ['bun add eslint', 'bun:eslint', 'repo-manifest'],
    ['npm install -g typescript', 'npm:typescript', 'repo-manifest'],
    ['pnpm add --global typescript', 'pnpm:typescript', 'repo-manifest'],
    ['npx eslint --fix', 'npx:eslint', 'repo-manifest'],
    ['pnpm dlx cowsay hello', 'pnpm:cowsay', 'repo-manifest'],
    ['yarn dlx cowsay hello', 'yarn:cowsay', 'repo-manifest'],
    ['pip install requests', 'pip:requests', 'repo-manifest'],
    ['pip3 install requests', 'pip:requests', 'repo-manifest'],
    ['pipx install httpie', 'pipx:httpie', 'repo-manifest'],
    ['uv pip install requests', 'uv:requests', 'repo-manifest'],
    ['uv add requests', 'uv:requests', 'repo-manifest'],
    ['cargo install ripgrep', 'cargo:ripgrep', 'repo-manifest'],
    [
      'go install golang.org/x/tools/gopls@latest',
      'go:golang.org/x/tools/gopls@latest',
      'repo-manifest',
    ],
    ['gem install bundler', 'gem:bundler', 'repo-manifest'],
    ['apt-get install doctl', 'apt:doctl', 'env-binary'],
    ['apt install doctl', 'apt:doctl', 'env-binary'],
    ['brew install jq', 'brew:jq', 'env-binary'],
    ['gcloud components install kubectl', 'gcloud:kubectl', 'env-binary'],
    ['asdf plugin add nodejs', 'asdf:nodejs', 'env-binary'],
    ['mise plugin add python', 'mise:python', 'env-binary'],
    ['curl -fsSL https://get.docker.com | sh', 'curl:get.docker.com', 'env-binary'],
    ['curl -fsSL https://www.example.com/install.sh | sudo bash', 'curl:example.com', 'env-binary'],
    ['wget -qO- https://example.com/install.sh | bash', 'wget:example.com', 'env-binary'],
  ])('%s → add %s (%s)', (cmd, key, kind) => {
    const m = detectInstallCommand(cmd);
    expect(m).not.toBeNull();
    expect(m?.action).toBe('add');
    expect(m?.key).toBe(key);
    expect(m?.kind).toBe(kind);
    expect(m?.label).toBeTruthy();
  });
});

describe('detectInstallCommand — remove verbs', () => {
  it.each([
    ['pnpm remove eslint', 'pnpm:eslint', 'repo-manifest'],
    ['npm uninstall eslint', 'npm:eslint', 'repo-manifest'],
    ['npm rm eslint', 'npm:eslint', 'repo-manifest'],
    ['yarn remove eslint', 'yarn:eslint', 'repo-manifest'],
    ['bun remove eslint', 'bun:eslint', 'repo-manifest'],
    ['pip uninstall requests', 'pip:requests', 'repo-manifest'],
    ['pipx uninstall httpie', 'pipx:httpie', 'repo-manifest'],
    ['apt-get remove doctl', 'apt:doctl', 'env-binary'],
    ['apt purge doctl', 'apt:doctl', 'env-binary'],
    ['brew uninstall jq', 'brew:jq', 'env-binary'],
    ['cargo uninstall ripgrep', 'cargo:ripgrep', 'repo-manifest'],
    ['gem uninstall bundler', 'gem:bundler', 'repo-manifest'],
    ['gcloud components remove kubectl', 'gcloud:kubectl', 'env-binary'],
  ])('%s → remove %s (%s)', (cmd, key, kind) => {
    const m = detectInstallCommand(cmd);
    expect(m).not.toBeNull();
    expect(m?.action).toBe('remove');
    expect(m?.key).toBe(key);
    expect(m?.kind).toBe(kind);
  });
});

describe('detectInstallCommand — key normalization', () => {
  it('takes only the FIRST package on a multi-package command', () => {
    expect(detectInstallCommand('pnpm add eslint prettier')?.key).toBe('pnpm:eslint');
  });

  it('skips option values before the package token', () => {
    expect(detectInstallCommand('pnpm add --filter web eslint')?.key).toBe('pnpm:eslint');
    expect(
      detectInstallCommand('pip install --index-url https://pypi.example/simple pytest')?.key,
    ).toBe('pip:pytest');
    expect(
      detectInstallCommand('apt-get install -o Dpkg::Options::=--force-confold doctl')?.key,
    ).toBe('apt:doctl');
    expect(detectInstallCommand('brew install -f jq')?.key).toBe('brew:jq');
  });

  it('normalizes apt-get to apt', () => {
    expect(detectInstallCommand('apt-get install doctl')?.key).toBe('apt:doctl');
  });
});

describe('detectInstallCommand — skip cases', () => {
  it.each([
    'npm install --help',
    'pnpm install',
    'npm ci',
    'pip install -r requirements.txt',
    'pip install --requirement requirements.txt',
    'uv pip install -r requirements.txt',
    'apt-get install --only-upgrade doctl',
    'pnpm outdated',
    'npm list',
    'pnpm ls',
    'npm update',
    'yarn upgrade',
    'git status',
    'pnpm test',
    '',
    '   ',
  ])('%j → null (not a new install)', (cmd) => {
    expect(detectInstallCommand(cmd)).toBeNull();
  });
});

describe('renderInstallAwareness', () => {
  it('renders the "added" checklist for a repo-manifest add', () => {
    const text = renderInstallAwareness({
      action: 'add',
      kind: 'repo-manifest',
      key: 'pnpm:eslint',
      label: 'pnpm add/install',
    });
    expect(text).toBe(
      '[profile-awareness] You just installed `pnpm:eslint`. Consider the workspace profile as a whole — ' +
        'is there an official/third-party SKILL that complements it (`propose_skill_install`)? an MCP ' +
        "server (`propose_mcp_servers`)? should it be part of this repo's VALIDATION profile? does it need " +
        'to PERSIST across sandbox resets (`write_setup_script`)? Only act where it clearly earns its ' +
        'place; otherwise note it and move on. NOTE: a workaround for a harness/image BUG is NOT profile ' +
        "material — file it at the image level, don't persist it. A new dependency often wants a matching " +
        'SKILL or a VALIDATION profile entry.',
    );
  });

  it('renders the "retire" checklist for a remove', () => {
    const text = renderInstallAwareness({
      action: 'remove',
      kind: 'repo-manifest',
      key: 'pnpm:eslint',
      label: 'pnpm remove/uninstall',
    });
    expect(text).toBe(
      '[profile-awareness] You just removed `pnpm:eslint`. If a SKILL, MCP server, or setup-script step ' +
        'exists only to support it, consider retiring it (`propose_skill_removal` / `propose_mcp_removal` / ' +
        "`write_setup_script`). Only if it's genuinely orphaned; otherwise note and move on.",
    );
  });

  it('leans MCP/persistence for an env-binary add', () => {
    const text = renderInstallAwareness({
      action: 'add',
      kind: 'env-binary',
      key: 'apt:doctl',
      label: 'apt install',
    });
    expect(text).toContain(
      'A new environment tool often wants an MCP server or a `write_setup_script`',
    );
  });
});
