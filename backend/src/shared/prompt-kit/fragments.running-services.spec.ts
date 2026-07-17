import { describe, expect, it } from 'vitest';
import { renderRunningServicesNote, type RunningServiceInfo } from './system/fragments';

describe('renderRunningServicesNote', () => {
  it('returns "" for an empty list so the caller omits the block', () => {
    expect(renderRunningServicesNote([])).toBe('');
  });

  it('renders one line per service with port and url', () => {
    const services: RunningServiceInfo[] = [
      { name: 'web', port: 3000, url: 'https://abc123-web.preview.example' },
      { name: 'api', port: 8080, url: 'https://abc123-api.preview.example' },
    ];
    const out = renderRunningServicesNote(services);
    expect(out.startsWith('<running_services>')).toBe(true);
    expect(out.endsWith('</running_services>')).toBe(true);
    expect(out).toContain('- web — port 3000 — https://abc123-web.preview.example');
    expect(out).toContain('- api — port 8080 — https://abc123-api.preview.example');
    expect(out).toMatch(/REUSE them/);
    expect(out).toMatch(/do NOT restart/);
  });

  it('omits port when null and omits url when null', () => {
    const out = renderRunningServicesNote([{ name: 'worker', port: null, url: null }]);
    expect(out).toContain('\n- worker\n');
    expect(out).not.toContain('https://');
  });

  it('renders port without a url when the service is not exposed', () => {
    const out = renderRunningServicesNote([{ name: 'db', port: 5432, url: null }]);
    expect(out).toContain('- db — port 5432');
    expect(out).not.toContain('https://');
  });
});
