import { CONTEXT_BUCKETS, type ContextBucket } from './paths.js';
import type { ContextFileRef } from './phase-spec.js';

/** How a context file is named everywhere a human or an agent sees one. */
export function attachmentLabel(ref: ContextFileRef): string {
  return `context/${ref.bucket}/${ref.path}`;
}

/**
 * A path the agent typed → a reference, or `null` if it names nothing Atlas can serve.
 *
 * Lenient about the prefix on purpose: the brief hands the agent an absolute `contextRoot` and the
 * transcript shows `context/specs/…`, so all three of `specs/x.md`, `context/specs/x.md` and
 * `./specs/x.md` are things it will honestly type. Strict about the BUCKET, because the bucket is
 * the only part that carries meaning — an unknown one is a typo or an invention, and both are better
 * reported than guessed at.
 */
export function parseContextRef(raw: string): ContextFileRef | null {
  const trimmed = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const withoutRoot = trimmed.replace(/^context\//, '');
  const slash = withoutRoot.indexOf('/');
  if (slash <= 0) return null;

  const bucket = withoutRoot.slice(0, slash);
  const path = withoutRoot.slice(slash + 1);
  if (path.length === 0) return null;
  if (!isBucket(bucket)) return null;
  return { bucket, path };
}

function isBucket(value: string): value is ContextBucket {
  return (CONTEXT_BUCKETS as readonly string[]).includes(value);
}

/**
 * The phase's structural floor, then what the outgoing agent chose — in that order, deduplicated.
 *
 * The floor is a RULE ("every unnumbered file in the bucket") and the declaration is a decision, and
 * they compose rather than compete: a forgotten attachment is silent and surfaces only as a
 * successor that mysteriously does not know something, so the floor guarantees the map arrives even
 * when the agent forgets. The agent's list goes ON TOP; it never replaces the floor.
 *
 * Floor first because it is the orientation and the declaration is the specifics, which is also the
 * order they should be read in.
 */
export function mergeAttachments(args: {
  floor: readonly ContextFileRef[];
  declared: readonly ContextFileRef[];
}): readonly ContextFileRef[] {
  const seen = new Set<string>();
  const merged: ContextFileRef[] = [];
  for (const ref of [...args.floor, ...args.declared]) {
    const key = attachmentLabel(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

/** A file as the seed carries it: the reference, and its body — or `null` when it is not there. */
export type AttachedFile = {
  ref: ContextFileRef;
  body: string | null;
};

/**
 * One attached file as the STORED message keeps it: what it was called, how big it was, and what it
 * said at the moment it was handed over.
 *
 * The manifest exists so the transcript can draw chips without parsing the composed body back apart,
 * and so expanding one slices what that thread WAS GIVEN rather than re-reading a file that has
 * moved on — `specs/` is mutable during build, so those two answers genuinely differ.
 *
 * `body` is the whole file, not a preview: the wire form is assembled FROM the parts, so there is
 * exactly one copy of the text and no way for the chip and the model's prompt to disagree.
 */
export type AttachmentPart = {
  /** `context/specs/spec.md` — the same name the fence carries and the chip shows. */
  label: string;
  lines: number;
  bytes: number;
  /** `null` where the file was not there when the seam composed the message. */
  body: string | null;
};

/** Files read off disk → the manifest a message stores. The one place sizes are counted. */
export function attachmentParts(
  files: readonly AttachedFile[],
): readonly AttachmentPart[] {
  return files.map((file) => ({
    label: attachmentLabel(file.ref),
    lines: file.body === null ? 0 : file.body.split('\n').length,
    // `TextEncoder` rather than `Buffer`, because `domain/` does not import node — and bytes, not
    // characters, because that is what the chip claims and what an emoji-bearing spec really costs.
    bytes: file.body === null ? 0 : new TextEncoder().encode(file.body).length,
    body: file.body,
  }));
}

/**
 * Attachments, inlined in full.
 *
 * Inlined and not listed as paths because `Read` truncates silently, and a hand-off whose tail the
 * successor never saw is a failure nobody notices. The cost is tokens at the seam, which is exactly
 * what the seam is for.
 *
 * A missing file is REPORTED rather than dropped: the outgoing agent believed it was handing
 * something over, and a successor told "this was meant to be here" can go and look, where one told
 * nothing cannot.
 */
export function renderAttachments(files: readonly AttachedFile[]): string {
  return renderAttachmentParts(attachmentParts(files));
}

/**
 * The wire form, assembled from the manifest at send.
 *
 * The same bytes `renderAttachments` always produced — it now goes through here — so that the stored
 * parts and the string the model receives cannot drift: there is one composer, and both the prompt
 * and the chips are views of the same rows.
 */
export function renderAttachmentParts(
  parts: readonly AttachmentPart[],
): string {
  if (parts.length === 0) return '';
  const blocks = parts.map((part) => {
    if (part.body === null)
      return `--- ${part.label} — MISSING, nothing was attached ---`;
    return [
      `--- ${part.label} (${part.lines} line${part.lines === 1 ? '' : 's'}) ---`,
      part.body,
      `--- end ${part.label} ---`,
    ].join('\n');
  });
  return ['# Attached', ...blocks].join('\n\n');
}

/**
 * The collapsed chip: `specs/spec.md (165 lines) 5.0 KB`.
 *
 * The `context/` prefix is dropped because every chip carries it and the bucket is what distinguishes
 * one from another. A missing file still gets a chip — the transcript records what the seam TRIED to
 * hand over, and a file that silently left no trace is the failure this whole path exists to avoid.
 */
export function attachmentChip(part: AttachmentPart): string {
  const name = part.label.replace(/^context\//, '');
  if (part.body === null) return `${name} — missing`;
  return `${name} (${part.lines} line${part.lines === 1 ? '' : 's'}) ${formatBytes(part.bytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  // One decimal only while it says something: `5.4 KB` is a size, `147.3 KB` is noise.
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

/**
 * The id a message's attachments expand under.
 *
 * Deliberately the transcript's EXISTING expansion set rather than a second one: `x` / `X` mean
 * "open the thing I am looking at", and a reader does not think of a chip and a tool result as two
 * different mechanisms. Namespaced so it can never collide with a `toolUseId`.
 */
export function attachmentExpandKey(messageId: string): string {
  return `attach:${messageId}`;
}
