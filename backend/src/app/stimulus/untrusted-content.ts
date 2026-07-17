
import { renderChunk } from '@shared/stimulus/chunk-vocabulary';

export const UNTRUSTED_OPEN = '<<<UNTRUSTED_EVENT_DATA>>>';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_EVENT_DATA>>>';

export function wrapUntrusted(input: { source: string; severity: string; body: string }): string {
  return renderChunk({
    kind: 'untrusted',
    body: input.body,
    attrs: { source: input.source, severity: input.severity },
  });
}

export function stripFenceTokens(body: string): string {
  return body.split(UNTRUSTED_OPEN).join('').split(UNTRUSTED_CLOSE).join('');
}
