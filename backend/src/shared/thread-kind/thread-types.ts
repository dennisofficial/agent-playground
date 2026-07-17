export const THREAD_TYPES = [
  'backend',
  'frontend',
  'docs',
  'testing',
  'infra',
  'data',
  'general',
] as const;

export type ThreadType = (typeof THREAD_TYPES)[number];

const THREAD_TYPE_SET = new Set<string>(THREAD_TYPES);

export function coerceThreadType(raw: unknown): ThreadType {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (THREAD_TYPE_SET.has(value) ? value : 'general') as ThreadType;
}
