import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact';

describe('redactSecrets', () => {
  it('leaves a benign string untouched', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
  });

  it('masks an OpenAI-style key', () => {
    const s = 'key is sk-abcdefghijklmnopqrstuvwxyz0123456789 in the log';
    expect(redactSecrets(s)).toBe('key is ***REDACTED*** in the log');
  });

  it('masks a GitHub personal access token (classic prefix)', () => {
    const s = `token=ghp_${'a'.repeat(36)}`;
    expect(redactSecrets(s)).not.toContain('ghp_');
    expect(redactSecrets(s)).toContain('***REDACTED***');
  });

  it('masks a GitHub fine-grained PAT', () => {
    const s = `github_pat_${'a'.repeat(30)}`;
    expect(redactSecrets(s)).toBe('***REDACTED***');
  });

  it('masks an AWS access key id', () => {
    const s = 'AKIAABCDEFGHIJKLMNOP';
    expect(redactSecrets(s)).toBe('***REDACTED***');
  });

  it('masks a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZQ';
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(
      'Authorization: Bearer ***REDACTED***',
    );
  });

  it('masks user:pass@ in a connection string, keeping scheme and host', () => {
    const s = 'postgres://myuser:s3cr3t@db.internal:5432/atlas';
    expect(redactSecrets(s)).toBe(
      'postgres://***REDACTED***@db.internal:5432/atlas',
    );
  });

  it('masks a PEM private key block wholesale', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`before ${pem} after`)).toBe(
      'before ***REDACTED*** after',
    );
  });

  it('masks a generic key/secret/token/password assignment, keeping the key prefix', () => {
    expect(redactSecrets('password: "hunter2"')).toBe(
      'password: "***REDACTED***"',
    );
    expect(redactSecrets('api_key=abcxyz123')).toBe('api_key=***REDACTED***');
    expect(redactSecrets("token: 'tok_live_abc'")).toBe(
      "token: '***REDACTED***'",
    );
  });

  it('keeps raw JSONL parseable when redacting assignment-looking text inside a JSON string', () => {
    const line =
      '{"timestamp":"2026-07-10T22:00:00.000Z","message":{"content":"api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789"}}';
    const redacted = redactSecrets(line) as string;
    expect(() => JSON.parse(redacted)).not.toThrow();
    expect(JSON.parse(redacted).message.content).toBe('api_key=***REDACTED***');
  });

  it('preserves dates so JSON serialization keeps timestamp fields useful', () => {
    const date = new Date('2026-07-10T12:34:56.000Z');
    const out = redactSecrets({ createdAt: date }) as { createdAt: Date };
    expect(out.createdAt).toBe(date);
    expect(JSON.stringify(out)).toBe(
      '{"createdAt":"2026-07-10T12:34:56.000Z"}',
    );
  });

  it('redacts secret-named object keys, walks nested arrays/objects, and is cycle-safe', () => {
    const cyclic: Record<string, unknown> = {
      name: 'job-1',
      secret: 'zzz',
      nested: { password: 'p' },
    };
    cyclic.self = cyclic;
    const out = redactSecrets({
      list: [{ token: 'abc' }, 'plain text'],
      obj: cyclic,
    }) as Record<string, unknown>;
    expect((out.list as unknown[])[0]).toEqual({ token: '***REDACTED***' });
    expect((out.list as unknown[])[1]).toBe('plain text');
    const obj = out.obj as Record<string, unknown>;
    expect(obj.name).toBe('job-1');
    expect(obj.secret).toBe('***REDACTED***');
    expect((obj.nested as Record<string, unknown>).password).toBe(
      '***REDACTED***',
    );
    expect(obj.self).toBe('[circular]');
  });

  it('redacts structured token/secret key variants even when the value shape is opaque', () => {
    expect(
      redactSecrets({
        access_token: 'opaque-access',
        refreshToken: 'opaque-refresh',
        client_secret: 'opaque-client-secret',
        idToken: 'opaque-id-token',
      }),
    ).toEqual({
      access_token: '***REDACTED***',
      refreshToken: '***REDACTED***',
      client_secret: '***REDACTED***',
      idToken: '***REDACTED***',
    });
  });
});
