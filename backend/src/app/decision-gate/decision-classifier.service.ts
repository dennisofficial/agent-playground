import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Decision, DecisionClass } from '../domain';
import { CLASSIFIER_LLM, type ClassifierLlm } from './classifier-llm';
import type {
  ClassifierRecord,
  DecisionClassification,
  ProposedDecision,
} from './decision-gate.types';

/**
 * W5 — the DECISION-CLASS CLASSIFIER. Given a proposed decision + the locked decision record, returns
 * one of three verdicts (see `DecisionVerdict`):
 *
 *   1. `covered`  — the record already settles this class (the thread planner proceeds silently).
 *   2. `proceed`  — a NEVER-ASK call (internal structure, naming, file placement, test layout, refactor
 *                   mechanics) — proceed but surface in the posted plan.
 *   3. `ask`      — an UNCOVERED always-ask class — park & ask.
 *
 * HYBRID by design: deterministic keyword rules settle the well-defined classes (cheap, fast, audit-
 * able), and an LLM (Haiku via the `ClassifierLlm` port) adjudicates only the ambiguous tail. The bias
 * is CONSERVATIVE — when the rules are silent AND the LLM is unavailable or unsure, default to `ask`
 * (a one-way-door mistake is far costlier than an over-park). This is the security control too: an
 * injected "go change X" in an untrusted body that touches an always-ask class parks, never executes.
 *
 * Zero v1 imports.
 */
@Injectable()
export class DecisionClassifier {
  private readonly logger = new Logger(DecisionClassifier.name);

  constructor(@Inject(CLASSIFIER_LLM) private readonly llm: ClassifierLlm) {}

  /**
   * Classify ONE proposed decision against the record.
   * @param proposed the decision the thread planner wants to make.
   * @param record   the locked decision record (the `decisions` slice is all that's read).
   * @param orgId   the tenant whose Anthropic key backs the ambiguous-tail LLM call (omit → env).
   */
  async classify(
    proposed: ProposedDecision,
    record: ClassifierRecord,
    orgId?: string,
  ): Promise<DecisionClassification> {
    const text =
      `${proposed.description}\n${proposed.context ?? ''}`.toLowerCase();

    // ── 1. Deterministic always-ask detection ───────────────────────────────────────────────────
    // Each class has a keyword signature; the FIRST that hits decides the touched class.
    const touched = detectAlwaysAskClass(text);

    if (touched) {
      // The decision touches an always-ask class. Is it already settled by a locked decision?
      const covering = findCovering(record.decisions, touched);
      if (covering) {
        return {
          verdict: 'covered',
          decisionClass: touched,
          reason: `Already settled by the decision record: "${covering.title}".`,
          via: 'rule',
          coveredBy: covering.title,
        };
      }
      return {
        verdict: 'ask',
        decisionClass: touched,
        reason: `Touches an always-ask class (${CLASS_LABELS[touched]}) not covered by the record.`,
        via: 'rule',
      };
    }

    // ── 2. Deterministic never-ask detection ────────────────────────────────────────────────────
    // Clear internal-mechanics signals → proceed without an LLM call.
    if (NEVER_ASK_RE.test(text)) {
      return {
        verdict: 'proceed',
        reason:
          'Internal structure / naming / file placement / test layout — never-ask.',
        via: 'rule',
      };
    }

    // ── 3. Ambiguous tail → LLM (conservative on failure) ───────────────────────────────────────
    const recordSummary = record.decisions
      .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
      .join('\n');
    try {
      const verdict = await this.llm.classify({
        description: proposed.description,
        ...(proposed.context ? { context: proposed.context } : {}),
        recordSummary,
        ...(orgId ? { orgId } : {}),
      });
      if (verdict) {
        const cls = normalizeClass(verdict.decisionClass);
        // If the LLM says ask AND named a class the record already covers, downgrade to covered.
        if (verdict.verdict === 'ask' && cls) {
          const covering = findCovering(record.decisions, cls);
          if (covering) {
            return {
              verdict: 'covered',
              decisionClass: cls,
              reason: `Already settled by the decision record: "${covering.title}".`,
              via: 'llm',
              coveredBy: covering.title,
            };
          }
        }
        return {
          verdict: verdict.verdict,
          ...(verdict.verdict === 'ask' && cls ? { decisionClass: cls } : {}),
          reason: verdict.reason,
          via: 'llm',
        };
      }
    } catch (err) {
      this.logger.warn(
        `classifier LLM failed, defaulting to ask: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // No rule fired and no usable LLM verdict → be conservative.
    return {
      verdict: 'ask',
      reason: 'Unclear and unverified — defaulting to ask (conservative).',
      via: this.llm ? 'llm' : 'rule',
    };
  }
}

/** Human labels for the always-ask classes (used in rationales). */
const CLASS_LABELS: Record<DecisionClass, string> = {
  data_model: 'data model / schema',
  api_contract: 'public / cross-service API contract',
  dependency: 'new dependency / library / service',
  infrastructure: 'infrastructure / topology',
  cross_cutting:
    'cross-cutting pattern (auth/caching/state/concurrency/error-handling)',
  one_way_door: 'one-way door (irreversible)',
};

/**
 * Keyword signatures per always-ask class, in priority order (the first match wins). Word-boundary
 * anchored to avoid substring false-positives (e.g. "scheme" not matching "schema"). The set is
 * intentionally broad: over-parking is cheaper than under-parking.
 */
const ALWAYS_ASK_RULES: Array<{ cls: DecisionClass; re: RegExp }> = [
  {
    cls: 'data_model',
    re: /\b(schema|migration|add (a |an )?(\w+ )?column|new column|drop column|new table|alter table|database model|data model|er diagram|primary key|foreign key|index on|denormaliz|entity (field|column))\b/,
  },
  {
    cls: 'api_contract',
    re: /\b(api contract|public (api|endpoint|interface)|breaking change|request\/response|response (shape|schema)|graphql schema|grpc|openapi|rest endpoint|cross-service|wire format|public interface|versioned? (the )?api)\b/,
  },
  {
    cls: 'dependency',
    re: /\b(new (dependency|dependencies|library|libraries|package|service)|add (a |an )?(dependency|library|package|npm package)|install (a |the )?package|pull in (a|another)|introduce (a )?(new )?(lib|library|dependency|sdk)|third-party (lib|library|service)|adopt [a-z-]+ as)\b/,
  },
  {
    cls: 'infrastructure',
    re: /\b(infrastructure|topology|deploy(ment)? (config|target)|provision|kubernetes|k8s|terraform|docker(file| image)?|new (queue|bucket|cluster|environment)|load balancer|dns|networking|cloud (resource|service)|message broker|kafka|rabbitmq)\b/,
  },
  {
    cls: 'cross_cutting',
    re: /\b(auth(entication|orization)?|password ?(hashing|hash|storage)?|hashing|bcrypt|scrypt|argon2|pbkdf2|jwt|json web token|access token|refresh token|token (strategy|signing|expiry|rotation|storage)|bearer token|oauth2?|openid|sso|saml|csrf|session (management|store|strategy)|cookie (auth|session)|crypto(graphy)?|cipher|encryption|encrypt|decrypt|signing key|salt(ing)?|secret(s)? (management|store)|caching|cache strategy|state management|concurrency|locking|transaction(al)? (boundary|strategy)|error[- ]handling (strategy|pattern)|retry (policy|strategy)|rate[- ]limit(ing)?|session (management|store)|global (middleware|interceptor)|cross-cutting)\b/,
  },
  {
    cls: 'one_way_door',
    re: /\b(irreversible|one-way door|hard to (reverse|undo|roll ?back)|delete (production|user) data|data loss|destructive|permanent(ly)?|cannot be undone|drop (the )?(database|prod))\b/,
  },
];

/** Internal-mechanics signature → a clear never-ask. */
const NEVER_ASK_RE =
  /\b(rename|local (variable|helper|function)|extract (a )?(method|function|helper)|move (the )?file|file placement|directory structure|folder structure|test layout|where to put|naming|format(ting)?|lint|inline (a )?(variable|function)|reorganize|reorder|comment|jsdoc|docstring|private (method|helper)|internal (helper|structure))\b/;

/** Find the first always-ask class whose keyword signature the text matches. */
function detectAlwaysAskClass(text: string): DecisionClass | undefined {
  for (const rule of ALWAYS_ASK_RULES) {
    if (rule.re.test(text)) return rule.cls;
  }
  return undefined;
}

/** A locked decision of class `cls`, if the record has one. */
function findCovering(
  decisions: Decision[],
  cls: DecisionClass,
): Decision | undefined {
  return decisions.find((d) => d.decisionClass === cls);
}

/** Coerce an LLM-returned class string to a known `DecisionClass`, or undefined. */
function normalizeClass(raw: string | undefined): DecisionClass | undefined {
  if (!raw) return undefined;
  return raw in CLASS_LABELS ? (raw as DecisionClass) : undefined;
}
