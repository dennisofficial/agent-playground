import { describe, expect, it } from 'vitest';
import {
  hostFor,
  isValidExposedServiceName,
  previewId,
  routeId,
  routePrefix,
  urlFor,
} from './exposure-naming';

const SECRET = 'test-secret-key';
const DOMAIN = 'atlas.example.co';

describe('previewId', () => {
  it('is deterministic for the same job + secret', () => {
    expect(previewId('job-1', SECRET)).toBe(previewId('job-1', SECRET));
  });

  it('is 10 lowercase base32 chars', () => {
    const id = previewId('job-1', SECRET);
    expect(id).toHaveLength(10);
    expect(id).toMatch(/^[a-z2-7]{10}$/);
  });

  it('differs by job and by secret (unguessable without the secret)', () => {
    expect(previewId('job-1', SECRET)).not.toBe(previewId('job-2', SECRET));
    expect(previewId('job-1', SECRET)).not.toBe(previewId('job-1', 'other-secret'));
  });
});

describe('hostFor / urlFor', () => {
  it('composes <previewId>-<name>.<baseDomain>', () => {
    const id = previewId('job-1', SECRET);
    expect(hostFor('job-1', 'web', SECRET, DOMAIN)).toBe(`${id}-web.${DOMAIN}`);
  });

  it('urlFor is https over the host', () => {
    expect(urlFor('job-1', 'web', SECRET, DOMAIN)).toBe(
      `https://${hostFor('job-1', 'web', SECRET, DOMAIN)}`,
    );
  });
});

describe('isValidExposedServiceName', () => {
  it('accepts DNS-safe service names that fit under the wildcard label', () => {
    expect(isValidExposedServiceName('web')).toBe(true);
    expect(isValidExposedServiceName('admin-ui')).toBe(true);
    expect(isValidExposedServiceName('a'.repeat(52))).toBe(true);
  });

  it('rejects names that would produce invalid public hostnames', () => {
    expect(isValidExposedServiceName('api_server')).toBe(false);
    expect(isValidExposedServiceName('api-')).toBe(false);
    expect(isValidExposedServiceName('a'.repeat(53))).toBe(false);
  });
});

describe('routeId / routePrefix', () => {
  it('routeId is preview-<previewId>-<name>', () => {
    const id = previewId('job-1', SECRET);
    expect(routeId('job-1', 'web', SECRET)).toBe(`preview-${id}-web`);
  });

  it('routePrefix is the shared prefix of the job routes', () => {
    const prefix = routePrefix('job-1', SECRET);
    expect(routeId('job-1', 'web', SECRET).startsWith(prefix)).toBe(true);
    expect(routeId('job-1', 'api', SECRET).startsWith(prefix)).toBe(true);
    expect(prefix).toBe(`preview-${previewId('job-1', SECRET)}-`);
  });
});
