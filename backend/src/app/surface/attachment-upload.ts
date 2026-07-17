import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';


export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 25;

export const MIME_BY_EXT: Record<string, { mime: string; binary: boolean }> = {
  '.md': { mime: 'text/markdown', binary: false },
  '.markdown': { mime: 'text/markdown', binary: false },
  '.txt': { mime: 'text/plain', binary: false },
  '.log': { mime: 'text/plain', binary: false },
  '.json': { mime: 'application/json', binary: false },
  '.html': { mime: 'text/html', binary: false },
  '.htm': { mime: 'text/html', binary: false },
  '.css': { mime: 'text/css', binary: false },
  '.js': { mime: 'text/javascript', binary: false },
  '.ts': { mime: 'text/plain', binary: false },
  '.tsx': { mime: 'text/plain', binary: false },
  '.yaml': { mime: 'text/plain', binary: false },
  '.yml': { mime: 'text/plain', binary: false },
  '.csv': { mime: 'text/csv', binary: false },
  '.xml': { mime: 'application/xml', binary: false },
  '.svg': { mime: 'image/svg+xml', binary: false }, // text content, rendered as an image
  '.png': { mime: 'image/png', binary: true },
  '.jpg': { mime: 'image/jpeg', binary: true },
  '.jpeg': { mime: 'image/jpeg', binary: true },
  '.gif': { mime: 'image/gif', binary: true },
  '.webp': { mime: 'image/webp', binary: true },
  '.avif': { mime: 'image/avif', binary: true },
  '.zip': { mime: 'application/zip', binary: true },
};

export const ATTACHMENT_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg', // images
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.json',
  '.csv',
  '.xml',
  '.yaml',
  '.yml', // text
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.pdf', // code + pdf
  '.zip', // archive — Read on demand, extracted by the brain
]);

export interface UploadedAttachment {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export function safeUploadName(original: string): string {
  const base =
    basename(original)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'file';
  return `${randomBytes(4).toString('hex')}-${base}`;
}
