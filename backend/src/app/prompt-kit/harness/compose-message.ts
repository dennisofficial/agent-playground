/**
 * prompt-kit / harness / compose-message — the ONE renderer for every inbound `Message` variant.
 *
 * `composeMessageBody` is the single exhaustive switch that turns a typed `Message` (every variant EXCEPT
 * `UserMessage`, which keeps its own operator path) into the `AgentMessage` body the brain receives plus the
 * optional `SeedRow` render command that makes the seeded turn legible in the transcript. Each arm calls the
 * existing `seed-catalog` builder and mints its `chunkKey` through the `chunk-keys` registry, so a body and its
 * dedup key stay byte-identical to the construction sites this centralizes. A new `Message` variant with no arm
 * fails the build at `assertNever` — the exhaustiveness guard this refactor exists for.
 */
import type { Message, UserMessage } from '@shared/domain/message';
import { assertNever } from '@shared/domain/message';
import type { SeedRow } from '@shared/domain/seed-row';
import { chunkKey } from '@shared/prompt-kit/harness/chunk-keys';
import { renderChunk } from '@shared/prompt-kit/harness/tag-vocabulary';
import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import { shipOpenPrBody } from '../messages/ship-open-pr';
import {
  COMPACTION_INSTRUCTION,
  answeredQuestionBody,
  conventionAttached,
  conventionEdited,
  frameAnswer,
  maskedFileNotice,
  mcpApproved,
  mcpRemoved,
  mcpSecretOauthRefused,
  mcpSecretStoreFailed,
  mcpSecretStored,
  renderEventDelivery,
  renderFollowUpJobSeed,
  renderRequestChangesDelivery,
  renderWorkOwedNudge,
  resetContinuationNotice,
  retryResumeNudge,
  secretEphemeralDelivered,
  secretEphemeralUndelivered,
  secretStored,
  sessionLimitResetNudge,
  skillApproved,
  skillEditApproved,
  skillEditGone,
  wakeForAmendApprovedBody,
  wakeUnblockedRunningJobBody,
} from './seed-catalog';

type ComposedBody = { body: AgentMessage; seedRow?: SeedRow };

/**
 * Render the body (and, when the turn shows as a curated transcript pill, the `SeedRow`) for a non-user
 * `Message`. `UserMessage` is excluded — it stays on its own operator intake path, unchanged.
 */
export function composeMessageBody(m: Exclude<Message, UserMessage>): ComposedBody {
  switch (m.type) {
    case 'answer_question':
      return {
        body: frameAnswer(m.question, m.answer),
        seedRow: {
          label: answeredQuestionBody(m.question, m.answer),
          chunkKey: chunkKey.qa(m.jobId, m.questionId),
        },
      };
    case 'file_answered': {
      const fileNotice = maskedFileNotice(m.path);
      return {
        body: systemNotice(fileNotice),
        seedRow: {
          label: fileNotice,
          chunkKey: chunkKey.file(m.jobId, m.path),
        },
      };
    }
    case 'secret_provided':
      return composeSecretProvided(m);
    case 'reset_verify':
      // Plain wake body — this seed writes no curated pill; the verify instruction rides RESET_VERIFY_TEXT,
      // consumed by whichever turn cold-attaches first. Framed as a `<system_notice>` (matches `frameAnswer`)
      // so the engine reads it as trusted harness context, not a bare/untagged turn.
      return {
        body: agentMessage(
          renderChunk({
            kind: 'system_notice',
            body: resetContinuationNotice(),
          }),
        ),
      };
    case 'compaction':
      // VESTIGIAL: the job-level compaction-continuation fold was removed (every thread now starts from a
      // fresh JIT seed, never a compacted continuation), so nothing enqueues a `compaction` message anymore.
      // The arm remains only to keep the exhaustive switch total until the `compaction` variant is retired
      // from the shared `Message` union.
      return { body: COMPACTION_INSTRUCTION };
    case 'ship_open_pr':
      return {
        body: shipOpenPrBody({
          branch: m.branch,
          defaultBranch: m.defaultBranch,
          title: m.title,
        }),
        seedRow: {
          label: agentMessage('Opening the pull request.'),
          chunkKey: chunkKey.ship(m.jobId),
        },
      };
    case 'work_owed_nudge':
      return {
        body: agentMessage(renderChunk({ kind: 'system_notice', body: renderWorkOwedNudge() })),
        seedRow: {
          label: agentMessage('Resuming an interrupted plan review.'),
          chunkKey: chunkKey.workOwed(m.reviewId),
        },
      };
    case 'amend_approved_wake':
      return {
        body: wakeForAmendApprovedBody(),
        seedRow: {
          label: agentMessage('Amend approved — resuming post-build.'),
          chunkKey: chunkKey.amendApproved(m.jobId),
        },
      };
    case 'request_changes':
      return {
        body: agentMessage(
          renderChunk({
            kind: 'system_notice',
            body: renderRequestChangesDelivery(m.note),
          }),
        ),
        seedRow: {
          label: agentMessage('The operator requested changes.'),
          chunkKey: chunkKey.requestChanges(m.decisionRecordId),
        },
      };
    case 'unblocked_job_wake':
      return {
        body: agentMessage(
          renderChunk({
            kind: 'system_notice',
            body: wakeUnblockedRunningJobBody(m.blockers),
          }),
        ),
        seedRow: {
          label: agentMessage('All blocking jobs resolved — unblocked.'),
          chunkKey: chunkKey.unblock(m.jobId),
        },
      };
    case 'follow_up_job_seed':
      return {
        body: renderFollowUpJobSeed({
          firstMessage: m.firstMessage,
          parent: m.parent,
        }),
      };
    case 'retry_resume_nudge':
      return {
        body: retryResumeNudge(m.title),
        seedRow: {
          label: agentMessage('Resuming the turn after a transient engine error.'),
          chunkKey: chunkKey.retry(m.jobId, Date.now()),
        },
      };
    case 'session_limit_reset_nudge':
      return {
        body: sessionLimitResetNudge(m.title),
        seedRow: {
          label: agentMessage('Auto-resuming after the session limit reset.'),
          chunkKey: chunkKey.sessionLimit(m.jobId, Date.now()),
        },
      };
    case 'mcp_approved': {
      const body = mcpApproved({
        committed: m.committed,
        scope: m.scope,
        needSecrets: m.needSecrets,
        needConnect: m.needConnect,
        readyStatic: m.readyStatic,
      });
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.mcpApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'mcp_removed': {
      const body = mcpRemoved(m.removed, m.scope);
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.mcpRemove(m.jobId, m.requestId),
        },
      };
    }
    case 'convention_attached': {
      const body = conventionAttached(m.profileName);
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.convApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'convention_edited': {
      const body = conventionEdited(m.mode, m.name);
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.convEditApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'skill_approved': {
      const body = skillApproved(m.mode, m.name, m.scope);
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.skillApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'skill_edit_approved': {
      const body = skillEditApproved(m.name, m.forkedTo);
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.skillEditApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'skill_edit_gone': {
      const body = skillEditGone(m.name);
      // Shares the skill-edit-approve chunkKey: both are terminal outcomes of the same approve endpoint.
      return {
        body,
        seedRow: {
          label: body,
          chunkKey: chunkKey.skillEditApprove(m.jobId, m.requestId),
        },
      };
    }
    case 'event':
      return { body: renderEventDelivery(m) };
    default:
      return assertNever(m);
  }
}

/**
 * The `secret_provided` arm — branches on the server-initiated provide-secret `outcome`/`secretKind` to
 * pick the builder + chunkKey (mirrors `web-surface.controller`'s `provideSecret`/`applySecretProvide`). A
 * plain operator-supplied provide (no `outcome`) renders the generic notice with no curated pill.
 */
function composeSecretProvided(m: Extract<Message, { type: 'secret_provided' }>): ComposedBody {
  switch (m.outcome) {
    case 'undelivered': {
      const label = secretEphemeralUndelivered(m.name!, m.reason!);
      return {
        body: systemNotice(label),
        seedRow: {
          label,
          chunkKey: chunkKey.secret(m.jobId, m.name!, { fail: true }),
        },
      };
    }
    case 'delivered': {
      const label = secretEphemeralDelivered(m.name!);
      return {
        body: systemNotice(label),
        seedRow: { label, chunkKey: chunkKey.secret(m.jobId, m.name!) },
      };
    }
    case 'stored': {
      if (m.mcp) {
        const label = mcpSecretStored(m.mcp.key, m.mcp.server, m.mcp.slot);
        return {
          body: systemNotice(label),
          seedRow: {
            label,
            chunkKey: chunkKey.mcpSecret(m.jobId, m.mcp.server, m.mcp.key),
          },
        };
      }
      const label = secretStored(m.name!, m.path!);
      return {
        body: systemNotice(label),
        seedRow: { label, chunkKey: chunkKey.secret(m.jobId, m.name!) },
      };
    }
    case 'oauth_refused': {
      const label = mcpSecretOauthRefused(m.mcp!.server);
      return {
        body: systemNotice(label),
        seedRow: {
          label,
          chunkKey: chunkKey.mcpSecret(m.jobId, m.mcp!.server, m.mcp!.key, 'oauth'),
        },
      };
    }
    case 'store_failed': {
      const label = mcpSecretStoreFailed(m.mcp!.key, m.mcp!.server);
      return {
        body: systemNotice(label),
        seedRow: {
          label,
          chunkKey: chunkKey.mcpSecret(m.jobId, m.mcp!.server, m.mcp!.key, 'fail'),
        },
      };
    }
    default:
      // Plain operator-supplied provide — the generic Job-1 notice, no curated pill.
      return { body: systemNotice(agentMessage('A secret was provided.')) };
  }
}

function systemNotice(body: AgentMessage): AgentMessage {
  return agentMessage(renderChunk({ kind: 'system_notice', body }));
}
