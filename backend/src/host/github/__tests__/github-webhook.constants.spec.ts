import { createHmac } from 'node:crypto';
import { verifyGithubSignature } from '../github-webhook.constants';

const SECRET = 'shhh';
const BODY = Buffer.from(JSON.stringify({ zen: 'Keep it simple' }));

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('accepts a signature computed over the exact raw body', () => {
    expect(verifyGithubSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyGithubSignature(BODY, sign(BODY, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects when the body differs by a single byte', () => {
    const tampered = Buffer.from(BODY.toString() + ' ');
    expect(verifyGithubSignature(tampered, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGithubSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed signature without throwing on length mismatch', () => {
    expect(verifyGithubSignature(BODY, 'sha256=abc', SECRET)).toBe(false);
  });
});
