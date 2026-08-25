export type StimulusTrust = 'trusted' | 'untrusted';

export type SeedRow =
  | 'skip'
  | {
      label: string;
      chunkKey: string;
      kind?: 'system_notice' | 'untrusted';
      untrustedSource?: string;
      severity?: string;
      framing?: string;
    };

export type EventSeverity = 'info' | 'warning' | 'critical';
