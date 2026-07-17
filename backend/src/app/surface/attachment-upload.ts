import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';

/**
 * The shared upload-validation primitives for BOTH composer attachments (`WebSurfaceController.postMessage`
 * / `ingestAttachments`) and server-side draft attachments (`ComposerDraftService`) — one definition so the
 * two paths can never drift on caps, allowed extensions, or the on-disk naming scheme.
 */

/** Per-file cap for an attachment (images can be large screenshots). Enforced by multer + here. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max attachments per message / per draft. */
export const MAX_ATTACHMENTS = 25;

/** Best-effort mime + text/binary split by extension. Unknown → text/plain (we still cap the size). */
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

/**
 * The extensions an operator may attach in the composer (or stage in a draft). Images (Read renders them
 * visually) + a conservative set of text/doc types the brain's Read tool can parse, plus `.zip` —
 * attachments land in `/context/uploads/` and are Read on demand, so the brain can unzip an archive itself
 * when it needs to. Anything else is rejected. `.pdf` isn't in `MIME_BY_EXT` (added just here).
 */
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

/** The multipart file shape multer hands us (subset we use — avoids depending on global Express.Multer types). */
export interface UploadedAttachment {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Sanitize an operator-supplied filename into a flat, collision-resistant name safe as BOTH a disk path
 * and an XML attribute value: basename only (no dirs), `[A-Za-z0-9._-]` only (so no `../` traversal and no
 * forged `</user>`/`<uploaded-files>` tags), a short random prefix to de-collide, length-capped.
 */
export function safeUploadName(original: string): string {
  const base =
    basename(original)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'file';
  return `${randomBytes(4).toString('hex')}-${base}`;
}
