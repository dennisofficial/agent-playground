import { GithubTokenService } from '../github-token.service';

type Installation = { id: string; account: string | null } | null;

/** Build the service over minimal fakes; each test sets what the org "has". */
function makeService(opts: {
  pat?: string | null;
  installation?: Installation;
  mintThrows?: boolean;
  user?: { login: string; id: number; name: string | null };
}) {
  const pat = opts.pat ?? null;
  const installation = opts.installation ?? null;
  const credentials = {
    getGithubPat: vi.fn(async () => pat),
    hasGithubPat: vi.fn(async () => !!pat),
    getGithubAppInstallation: vi.fn(async () => installation),
  };
  const appTokens = {
    getInstallationToken: vi.fn(async () => {
      if (opts.mintThrows) throw new Error('mint failed');
      return 'install-token';
    }),
    appBotIdentity: vi.fn(async () => ({ name: 'atlas[bot]', email: '1+atlas[bot]@users.noreply.github.com' })),
  };
  const api = {
    getAuthenticatedUser: vi.fn(async () => opts.user ?? { login: 'octo', id: 42, name: 'Octo Cat' }),
  };
  const service = new GithubTokenService(credentials as never, appTokens as never, api as never);
  return { service, credentials, appTokens, api };
}

describe('hostToken (faceless — prefers the App installation token)', () => {
  it('mints the installation token when an installation exists', async () => {
    const { service } = makeService({ pat: 'pat', installation: { id: '9', account: 'acme' } });
    expect(await service.hostToken('o')).toBe('install-token');
  });

  it('falls back to the PAT when there is no installation', async () => {
    const { service } = makeService({ pat: 'pat', installation: null });
    expect(await service.hostToken('o')).toBe('pat');
  });

  it('returns null (never leaks the PAT) when minting fails despite a stored PAT', async () => {
    const { service } = makeService({ pat: 'pat', installation: { id: '9', account: null }, mintThrows: true });
    expect(await service.hostToken('o')).toBeNull();
  });

  it('returns null when the org has no credential at all', async () => {
    const { service } = makeService({ pat: null, installation: null });
    expect(await service.hostToken('o')).toBeNull();
  });
});

describe('sandboxToken (faced — prefers the PAT)', () => {
  it('returns the PAT when present, even if an installation also exists', async () => {
    const { service } = makeService({ pat: 'pat', installation: { id: '9', account: null } });
    expect(await service.sandboxToken('o')).toBe('pat');
  });

  it('falls back to the installation token when there is no PAT', async () => {
    const { service } = makeService({ pat: null, installation: { id: '9', account: null } });
    expect(await service.sandboxToken('o')).toBe('install-token');
  });

  it('returns null when neither is available', async () => {
    const { service } = makeService({ pat: null, installation: null });
    expect(await service.sandboxToken('o')).toBeNull();
  });
});

describe('commitIdentity', () => {
  it('resolves the human face from the PAT (name || login + noreply email)', async () => {
    const { service } = makeService({ pat: 'pat', installation: { id: '9', account: null } });
    expect(await service.commitIdentity('o')).toEqual({
      name: 'Octo Cat',
      email: '42+octo@users.noreply.github.com',
    });
  });

  it('falls back to login when the user has no name', async () => {
    const { service } = makeService({ pat: 'pat', user: { login: 'octo', id: 42, name: null } });
    expect(await service.commitIdentity('o')).toEqual({
      name: 'octo',
      email: '42+octo@users.noreply.github.com',
    });
  });

  it('wears the App bot face when the org has no PAT', async () => {
    const { service } = makeService({ pat: null, installation: { id: '9', account: null } });
    expect(await service.commitIdentity('o')).toEqual({
      name: 'atlas[bot]',
      email: '1+atlas[bot]@users.noreply.github.com',
    });
  });

  it('is null when there is neither a PAT nor an installation', async () => {
    const { service } = makeService({ pat: null, installation: null });
    expect(await service.commitIdentity('o')).toBeNull();
  });
});

describe('hasAnyGithub', () => {
  it('is true with only a PAT', async () => {
    const { service } = makeService({ pat: 'pat', installation: null });
    expect(await service.hasAnyGithub('o')).toBe(true);
  });

  it('is true with only an installation', async () => {
    const { service } = makeService({ pat: null, installation: { id: '9', account: null } });
    expect(await service.hasAnyGithub('o')).toBe(true);
  });

  it('is false with neither', async () => {
    const { service } = makeService({ pat: null, installation: null });
    expect(await service.hasAnyGithub('o')).toBe(false);
  });
});
