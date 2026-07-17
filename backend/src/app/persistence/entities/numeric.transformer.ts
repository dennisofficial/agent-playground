import type { ValueTransformer } from 'typeorm';

export const numberColumn: ValueTransformer = {
  to: (v: number | null | undefined) => v,
  from: (v: string | null) => (v == null ? v : Number(v)),
};
