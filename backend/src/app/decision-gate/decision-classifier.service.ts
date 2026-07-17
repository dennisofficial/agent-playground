import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Decision, DecisionClass } from '@shared/domain';
import { CLASSIFIER_LLM, type ClassifierLlm } from './classifier-llm';
import type {
  ClassifierRecord,
  DecisionClassification,
  ProposedDecision,
} from './decision-gate.types';

@Injectable()
export class DecisionClassifier {
  private readonly logger = new Logger(DecisionClassifier.name);

  constructor(@Inject(CLASSIFIER_LLM) private readonly llm: ClassifierLlm) {}

  async classify(
    proposed: ProposedDecision,
    record: ClassifierRecord,
    orgId?: string,
  ): Promise<DecisionClassification> {
    const text = `${proposed.description}\n${proposed.context ?? ''}`.toLowerCase();

    const touched = detectAlwaysAskClass(text);

    if (touched) {
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

    if (NEVER_ASK_RE.test(text)) {
      return {
        verdict: 'proceed',
        reason: 'Internal structure / naming / file placement / test layout — never-ask.',
        via: 'rule',
      };
    }

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

    return {
      verdict: 'ask',
      reason: 'Unclear and unverified — defaulting to ask (conservative).',
      via: this.llm ? 'llm' : 'rule',
    };
  }
}

const CLASS_LABELS: Record<DecisionClass, string> = {
  data_model: 'data model / schema',
  api_contract: 'public / cross-service API contract',
  dependency: 'new dependency / library / service',
  infrastructure: 'infrastructure / topology',
  cross_cutting: 'cross-cutting pattern (auth/caching/state/concurrency/error-handling)',
  one_way_door: 'one-way door (irreversible)',
};

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

const NEVER_ASK_RE =
  /\b(rename|local (variable|helper|function)|extract (a )?(method|function|helper)|move (the )?file|file placement|directory structure|folder structure|test layout|where to put|naming|format(ting)?|lint|inline (a )?(variable|function)|reorganize|reorder|comment|jsdoc|docstring|private (method|helper)|internal (helper|structure))\b/;

function detectAlwaysAskClass(text: string): DecisionClass | undefined {
  for (const rule of ALWAYS_ASK_RULES) {
    if (rule.re.test(text)) return rule.cls;
  }
  return undefined;
}

function findCovering(decisions: Decision[], cls: DecisionClass): Decision | undefined {
  return decisions.find((d) => d.decisionClass === cls);
}

function normalizeClass(raw: string | undefined): DecisionClass | undefined {
  if (!raw) return undefined;
  return raw in CLASS_LABELS ? (raw as DecisionClass) : undefined;
}
