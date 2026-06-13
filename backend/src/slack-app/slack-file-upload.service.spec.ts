import { SlackFileUploadService } from './slack-file-upload.service';

function makeClients(filesUploadV2Result: Record<string, unknown> = {}) {
  const webClient = {
    filesUploadV2: vi.fn(async () => filesUploadV2Result),
  };
  const clients = {
    clientFor: vi.fn(async () => webClient),
  };
  const identities = {
    clientFor: vi.fn(async () => undefined as unknown),
  };
  return { clients, identities, webClient };
}

const req = {
  teamId: 'T1',
  authorBotId: 'alex',
  content: '# Report\nHere is the analysis.',
  filename: 'report.md',
  title: 'Weekly Report',
};

describe('SlackFileUploadService', () => {
  it('uploads without channel_id and returns the file ID from the nested response', async () => {
    const fileId = 'F0GDJ3XMH';
    const { clients, identities, webClient } = makeClients({
      ok: true,
      files: [{ ok: true, files: [{ id: fileId, title: 'Weekly Report' }] }],
    });
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    const result = await svc.upload(req);

    expect(result).toEqual({ fileId });
    // Must NOT have channel_id in the upload call
    const uploadArgs = (
      webClient.filesUploadV2.mock.calls as unknown[][]
    )[0]?.[0] as Record<string, unknown>;
    expect(uploadArgs).not.toHaveProperty('channel_id');
  });

  it('uses puppet client when available (puppet-first)', async () => {
    const puppet = {
      filesUploadV2: vi.fn(async () => ({
        ok: true,
        files: [{ ok: true, files: [{ id: 'F_PUPPET', title: 'plan' }] }],
      })),
    };
    const ears = { filesUploadV2: vi.fn() };
    const clients = { clientFor: vi.fn(async () => ears) };
    const identities = { clientFor: vi.fn(async () => puppet) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    const result = await svc.upload(req);

    expect(puppet.filesUploadV2).toHaveBeenCalledTimes(1);
    expect(ears.filesUploadV2).not.toHaveBeenCalled();
    expect(result.fileId).toBe('F_PUPPET');
  });

  it('falls back to ears when no puppet token', async () => {
    const ears = {
      filesUploadV2: vi.fn(async () => ({
        ok: true,
        files: [{ ok: true, files: [{ id: 'F_EARS' }] }],
      })),
    };
    const clients = { clientFor: vi.fn(async () => ears) };
    const identities = { clientFor: vi.fn(async () => undefined) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    const result = await svc.upload(req);

    expect(ears.filesUploadV2).toHaveBeenCalledTimes(1);
    expect(result.fileId).toBe('F_EARS');
  });

  it('returns {} (no fileId) when no client available', async () => {
    const clients = { clientFor: vi.fn(async () => undefined) };
    const identities = { clientFor: vi.fn(async () => undefined) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    const result = await svc.upload(req);

    expect(result).toEqual({});
  });

  it('returns {} (no fileId) when upload throws, does not rethrow', async () => {
    const failClient = {
      filesUploadV2: vi.fn(async () => {
        throw new Error('missing_scope');
      }),
    };
    const clients = { clientFor: vi.fn(async () => failClient) };
    const identities = { clientFor: vi.fn(async () => undefined) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    await expect(svc.upload(req)).resolves.toEqual({});
  });

  it('passes content and filename to filesUploadV2 without channel_id', async () => {
    const client = {
      filesUploadV2: vi.fn(async () => ({
        ok: true,
        files: [{ ok: true, files: [{ id: 'F123' }] }],
      })),
    };
    const clients = { clientFor: vi.fn(async () => client) };
    const identities = { clientFor: vi.fn(async () => undefined) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    await svc.upload(req);

    const callArgs = (
      client.filesUploadV2.mock.calls[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(callArgs.content).toBe(req.content);
    expect(callArgs.filename).toBe(req.filename);
    expect(callArgs.title).toBe(req.title);
    expect(callArgs).not.toHaveProperty('channel_id');
  });

  it('defaults title to filename when title is omitted', async () => {
    const client = {
      filesUploadV2: vi.fn(async () => ({
        ok: true,
        files: [{ ok: true, files: [{ id: 'F456' }] }],
      })),
    };
    const clients = { clientFor: vi.fn(async () => client) };
    const identities = { clientFor: vi.fn(async () => undefined) };
    const svc = new SlackFileUploadService(
      clients as never,
      identities as never,
    );

    await svc.upload({ ...req, title: undefined });

    const callArgs = (
      client.filesUploadV2.mock.calls[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(callArgs.title).toBe(req.filename);
  });
});
