import type { JobMessage } from '@/lib/api/job-api';
import type {
  WebApprovalCard,
  WebAttachmentsCard,
  WebFileRequestCard,
  WebMcpProposalCard,
  WebQuestionCard,
  WebReviewCommentsCard,
  WebSecretInputCard,
  WebSkillProposalCard,
  WebVerdictCard,
} from '@/lib/api/types';
import { EInboundMessageType, EThreadOutputType } from '@workspace/shared';

/**
 * The conversation bubble kinds the work column renders. `approval`/`verdict` are STRUCTURED (the card
 * payload on the message); the rest are inferred from the text the brain emits, with a plain `claude`
 * fallback. (Robust typing would need richer message metadata from the backend — see BACKEND_GAPS.md.)
 */
export type SystemTone = 'ok' | 'warn' | 'accent' | 'neutral';

/** The `system_event` render kind's semantic subtype (`meta.eventKind`), stamped server-side from the raw
 *  GitHub/webhook event — drives {@link EventBubble}'s per-kind icon/label/style. */
export type EventKind =
  | 'ci_failure'
  | 'review_changes_requested'
  | 'review_approved'
  | 'review_comment';

/** The internal-seed `Message` type behind a `system_notice` row (`meta.seedType`), stamped server-side
 *  from the typed `InternalSeedMessage` discriminant (`domain/message.ts`). Drives {@link SystemNoticeRow}'s
 *  per-type icon/label pill, mirroring {@link EventKind}. */
export type SeedType =
  | 'reset_verify'
  | 'compaction'
  | 'work_owed_nudge'
  | 'amend_approved_wake'
  | 'ship_open_pr'
  | 'request_changes'
  | 'unblocked_job_wake'
  | 'follow_up_job_seed'
  | 'retry_resume_nudge'
  | 'session_limit_reset_nudge'
  | 'mcp_approved'
  | 'mcp_removed'
  | 'convention_attached'
  | 'convention_edited'
  | 'skill_approved'
  | 'skill_edit_approved'
  | 'skill_edit_gone';

export type ClassifiedMessage =
  | { kind: 'user'; message: JobMessage }
  | { kind: 'claude'; message: JobMessage }
  | { kind: 'thinking'; message: JobMessage }
  | { kind: 'tool'; message: JobMessage }
  | { kind: 'approval'; message: JobMessage; card: WebApprovalCard }
  | { kind: 'verdict'; message: JobMessage; card: WebVerdictCard }
  | { kind: 'question'; message: JobMessage; card: WebQuestionCard }
  /** A secure secret request (repo onboarding) — rendered as a masked input card. */
  | { kind: 'secret'; message: JobMessage; card: WebSecretInputCard }
  /** A secure file-upload request (repo onboarding) — rendered as a file picker card. */
  | { kind: 'file'; message: JobMessage; card: WebFileRequestCard }
  /** A stack-matched MCP-server recommendation (repo onboarding) — owner approves to register. */
  | { kind: 'mcp_proposal'; message: JobMessage; card: WebMcpProposalCard }
  /** A skill proposal (install a maintained skill / author a repo-idiom one / remove) — owner approves. */
  | { kind: 'skill_proposal'; message: JobMessage; card: WebSkillProposalCard }
  /** A sent inline-highlight review-comment batch — rendered as a distinct card, prose (if any) underneath. */
  | {
      kind: 'review_comments';
      message: JobMessage;
      card: WebReviewCommentsCard;
    }
  /** Files/images the operator attached in the composer — thumbnails on top, caption (if any) underneath. */
  | { kind: 'attachments'; message: JobMessage; card: WebAttachmentsCard }
  | { kind: 'event'; message: JobMessage; tone: SystemTone }
  /** A session-compaction pill that also carries the full handoff summary (expandable to inspect it). */
  | {
      kind: 'compaction';
      message: JobMessage;
      tone: SystemTone;
      summary: string;
    }
  /** System→operator+Atlas review block (e.g. Codex plan-review findings). Rendered as a distinct panel. */
  | { kind: 'system_shared'; message: JobMessage }
  /** An automated notification that opened this thread (a harness delivery to Atlas). Its own panel. */
  | { kind: 'system_event'; message: JobMessage }
  /** System→operator-only notice (e.g. an unresumable-thread error). Its own dedicated box. */
  | { kind: 'system_operator'; message: JobMessage }
  /** A harness-injected state-change chunk (sandbox reset, secret/file confirmation). Collapsed pill row. */
  | { kind: 'system_notice'; message: JobMessage }
  /** Harness context that rode alongside a turn (pipeline awareness, open-questions). Chip on the next user bubble. */
  | { kind: 'system_reminder'; message: JobMessage }
  /** Untrusted external data folded into a turn (event body, halted-thread record). Its own "untrusted" pill. */
  | { kind: 'untrusted'; message: JobMessage }
  /** A build-thread anchor row — driver bookkeeping with no operator-facing content, never rendered. */
  | { kind: 'build_anchor'; message: JobMessage };

const WARN_RE = /\b(paused|halt|failed|error|blocked|credential|expired)\b/i;
const OK_RE = /\b(resumed|done|completed|merged|approved|opened|landed)\b/i;

/**
 * Map a message's authoritative {@link EThreadMessageType} (stamped server-side) to the view's render kind —
 * the ONE place the data taxonomy meets the render taxonomy. It's an exhaustive switch, so adding a new
 * `EThreadMessageType` member fails to compile here (`assertNever`) until it's given a render kind. That is
 * the single-source guarantee: a new message type can't slip into the UI silently.
 *
 * Several intake types collapse to one render kind on purpose (an `operator`/`answer_question`/… all render
 * as the same user bubble) — the VIEW doesn't care which intake variety produced the bubble.
 */
export function classifyMessage(message: JobMessage): ClassifiedMessage {
  switch (message.type) {
    // Intake → user bubble (the view collapses every operator-originated variety).
    case EInboundMessageType.OPERATOR:
    case EInboundMessageType.ANSWER_QUESTION:
    case EInboundMessageType.FILE_ANSWERED:
    case EInboundMessageType.SECRET_PROVIDED:
      return { kind: 'user', message };
    case EInboundMessageType.REVIEW_COMMENTS:
      return { kind: 'review_comments', message, card: message.card as WebReviewCommentsCard };
    case EInboundMessageType.ATTACHMENTS:
      return { kind: 'attachments', message, card: message.card as WebAttachmentsCard };

    // Atlas output.
    case EThreadOutputType.CHAT:
      return { kind: 'claude', message };
    case EThreadOutputType.THINKING:
      return { kind: 'thinking', message };
    case EThreadOutputType.TOOL:
      return { kind: 'tool', message };
    case EThreadOutputType.APPROVAL:
      return { kind: 'approval', message, card: message.card as WebApprovalCard };
    case EThreadOutputType.VERDICT:
      return { kind: 'verdict', message, card: message.card as WebVerdictCard };
    case EThreadOutputType.QUESTION:
      return { kind: 'question', message, card: message.card as WebQuestionCard };
    case EThreadOutputType.SECRET_REQUEST:
      return { kind: 'secret', message, card: message.card as WebSecretInputCard };
    case EThreadOutputType.FILE_REQUEST:
      return { kind: 'file', message, card: message.card as WebFileRequestCard };
    case EThreadOutputType.MCP_PROPOSAL:
      return { kind: 'mcp_proposal', message, card: message.card as WebMcpProposalCard };
    case EThreadOutputType.SKILL_PROPOSAL:
      return { kind: 'skill_proposal', message, card: message.card as WebSkillProposalCard };

    // Pills / dividers.
    case EThreadOutputType.EVENT: {
      const summary = message.meta?.compactionSummary;
      if (typeof summary === 'string' && summary.length > 0)
        return { kind: 'compaction', message, tone: toneOf(message.text ?? ''), summary };
      return { kind: 'event', message, tone: toneOf(message.text ?? '') };
    }
    case EThreadOutputType.COMPACTION: {
      const summary = String(message.meta?.compactionSummary ?? message.text ?? '');
      return { kind: 'compaction', message, tone: toneOf(message.text ?? ''), summary };
    }
    case EThreadOutputType.BUILD_ANCHOR:
      // Bookkeeping anchor — peeled by the build lane; a no-op if one reaches the main switch.
      return { kind: 'build_anchor', message };

    // System provenance.
    case EThreadOutputType.SYSTEM_SHARED:
      return { kind: 'system_shared', message };
    case EThreadOutputType.SYSTEM_EVENT:
      return { kind: 'system_event', message };
    case EThreadOutputType.SYSTEM_OPERATOR:
      return { kind: 'system_operator', message };
    case EThreadOutputType.SYSTEM_NOTICE:
      return { kind: 'system_notice', message };
    case EThreadOutputType.SYSTEM_REMINDER:
      return { kind: 'system_reminder', message };
    case EThreadOutputType.UNTRUSTED:
      return { kind: 'untrusted', message };

    default: {
      // COMPILE-TIME exhaustiveness: if a new EThreadMessageType is added and left unhandled above, this
      // assignment fails to compile (its type is no longer `never`) — the single-source guarantee. But at
      // RUNTIME we must never crash the transcript on an unexpected/undefined type (an optimistic local row,
      // wire drift, a message written before this taxonomy) — fall back to plain prose.
      const _exhaustive: never = message.type;
      void _exhaustive;
      return { kind: 'claude', message };
    }
  }
}

export function toneOf(text: string): SystemTone {
  if (WARN_RE.test(text)) return 'warn';
  if (OK_RE.test(text)) return 'ok';
  if (/\[tool\]/.test(text)) return 'neutral';
  return 'accent';
}
