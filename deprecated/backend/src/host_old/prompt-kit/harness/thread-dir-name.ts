import { slugify } from '@workspace/shared';

export function threadDirName(thread: { ordinal: number; brief: string }): string {
  return `${String(thread.ordinal).padStart(3, '0')}-${slugify(thread.brief)}`;
}
