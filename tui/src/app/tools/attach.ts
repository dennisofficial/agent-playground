import { readFileSync } from 'node:fs';
import {
  attachmentLabel,
  attachmentParts,
  mergeAttachments,
  parseContextRef,
  renderAttachmentParts,
  type AttachedFile,
  type AttachmentPart,
} from '../../domain/attachments.js';
import { phaseSpecFor, type ContextFileRef } from '../../domain/phase-spec.js';
import type { EPhaseKind } from '../../generated/prisma/enums.js';
import type { ContextFolderService } from '../context-folder.service.js';

export type GatheredAttachments = {
  /** The block to inline into the successor's first message. Empty when there is nothing at all. */
  text: string;
  /** The same files as rows, for the message that stores them and the chips that draw them. */
  parts: readonly AttachmentPart[];
  /** Every file that made it, for the reply the caller reads back. */
  attached: readonly ContextFileRef[];
  /** Named by the agent and not on disk. Empty unless `report` let the gather past it. */
  missing: readonly ContextFileRef[];
  /** What the agent named that Atlas could not turn into a context path — told, never swallowed. */
  ignored: readonly string[];
};

/**
 * What a gather does about a file the agent named that is not there.
 *
 * Not a dial: the two call sites are genuinely different moments. A seam tool is gathering while the
 * agent still has the turn, so a refusal is a mistake it can fix. A confirmation is gathering hours
 * later on Dennis's keypress, where nobody can fix anything and sinking the advance would strand the
 * job over a file somebody tidied up.
 */
export enum EMissingAttachment {
  /** Throw, before anything is written. The default, because the seam is where the mistake is. */
  refuse = 'refuse',
  /** Inline a MISSING marker and carry on — delivery time, the advance must not be sunk. */
  report = 'report',
}

/**
 * The phase's floor plus the agent's declaration, read off disk and inlined.
 *
 * The floor is a rule — every unnumbered file in the phase's bucket, because numbered means one
 * thread's and unnumbered means everyone's — so a successor gets the map even when the outgoing
 * agent forgets to attach it. A forgotten attachment is otherwise silent, surfacing only as a thread
 * that mysteriously does not know something.
 */
export function gatherAttachments(args: {
  contextFolderService: ContextFolderService;
  jobId: string;
  phase: EPhaseKind;
  declared: readonly string[];
  onMissing?: EMissingAttachment;
}): GatheredAttachments {
  const listing = args.contextFolderService
    .list(args.jobId)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ bucket: entry.bucket, path: entry.path }));

  const parsed = args.declared.map((raw) => ({ raw, ref: parseContextRef(raw) }));
  const declared = parsed.flatMap((item) => (item.ref === null ? [] : [item.ref]));
  const refs = mergeAttachments({
    floor: phaseSpecFor(args.phase).attach(listing),
    declared,
  });

  const files: AttachedFile[] = refs.map((ref) => ({
    ref,
    body: readBody({
      contextFolderService: args.contextFolderService,
      jobId: args.jobId,
      ref,
    }),
  }));

  // Only what the AGENT named can be missing in a way worth refusing over. The floor comes from a
  // listing taken a line ago, so a null body there is a file deleted mid-gather — a race, not a
  // mistake, and it goes on to the successor as a MISSING marker like everything else.
  const missing = files
    .filter((file) => file.body === null)
    .map((file) => file.ref)
    .filter((ref) =>
      declared.some((item) => attachmentLabel(item) === attachmentLabel(ref)),
    );
  const onMissing = args.onMissing ?? EMissingAttachment.refuse;
  if (missing.length > 0 && onMissing === EMissingAttachment.refuse) {
    throw new Error(missingRefusal(missing));
  }

  const parts = attachmentParts(files);
  return {
    text: renderAttachmentParts(parts),
    parts,
    attached: refs,
    missing,
    ignored: parsed.flatMap((item) => (item.ref === null ? [item.raw] : [])),
  };
}

/**
 * Loud, and addressed to the agent that can still do something about it.
 *
 * The alternative — dropping the file and mentioning it in the reply — loses the handoff's second
 * half to a thread that will never know it was promised one. Ending the turn one tool call short is
 * the cheap failure; a successor working from half a brief is the expensive one.
 */
function missingRefusal(missing: readonly ContextFileRef[]): string {
  return [
    `cannot attach ${missing.map(attachmentLabel).join(', ')} — ${missing.length === 1 ? 'that file is' : 'those files are'} not in this job's context folder.`,
    'Attachments are inlined in full at the seam, so a name that resolves to nothing would hand your',
    'successor a gap it cannot see. Check the folder, fix the name — or drop it — and call again.',
  ].join(' ');
}

/**
 * `null` rather than a throw for a file that is not there. What happens next is the CALLER's policy
 * — `EMissingAttachment` — because a read that cannot find a file has not yet decided whether that
 * is a mistake somebody can fix or a race nobody can.
 */
function readBody(args: {
  contextFolderService: ContextFolderService;
  jobId: string;
  ref: ContextFileRef;
}): string | null {
  try {
    const absolute = args.contextFolderService.resolveInside({
      jobId: args.jobId,
      relativePath: `${args.ref.bucket}/${args.ref.path}`,
    });
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** One line the caller reads back, so it can see what actually went with its hand-off. */
export function describeAttachments(gathered: GatheredAttachments): string {
  // Missing files are subtracted from what is claimed as attached. Reporting a name under "attached"
  // when nothing came with it is the silent drop this ticket exists to remove, one layer up.
  const gone = new Set(gathered.missing.map(attachmentLabel));
  const landed = gathered.attached
    .map(attachmentLabel)
    .filter((label) => !gone.has(label));
  const parts = [
    landed.length === 0 ? 'no files attached' : `attached ${landed.join(', ')}`,
  ];
  if (gone.size > 0) parts.push(`MISSING, not attached: ${[...gone].join(', ')}`);
  if (gathered.ignored.length > 0) {
    parts.push(`ignored (not a context path): ${gathered.ignored.join(', ')}`);
  }
  return parts.join(' · ');
}
