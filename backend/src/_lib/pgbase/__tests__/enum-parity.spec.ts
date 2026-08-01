import {
  AUTO_MERGE_METHODS,
  EAgentCredentialKind,
  EAgentCredentialStatus,
  EAgentProvider,
  EInboundMessageStatus,
  EInboundPriority,
  EJobKind,
  EJobStatus,
  EMessageAudience,
  EMountMode,
  EOrgRole,
  EOrgStatus,
  ESubagentStatus,
  ETaskStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
  EUserRole,
  EUserStatus,
  THREAD_MESSAGE_TYPE_VALUES,
} from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import * as prismaEnums from '../../../generated/prisma/enums';

/**
 * Prisma emits a string-literal union per Postgres enum; shared declares a real TypeScript enum for
 * the same concept. Values are what actually cross the boundary, and a mismatch between the two is
 * invisible: reading a Prisma row into a shared-typed slot needs an `as E*` cast, and TypeScript
 * does NOT check an assertion between an enum and a *disjoint* string union — it compiles silently
 * and every comparison against it is false forever.
 *
 * That is not hypothetical. `EMountMode` shipped exactly that way: its labels used hyphens, which
 * are not valid identifiers, so Prisma @map'd them — and a mapped member keeps the schema identifier
 * as its JavaScript value while the database keeps the label. The client returned 'per_thread' for a
 * row stored as 'per-thread'. The cast at the call site compiled clean.
 *
 * So this asserts the thing the compiler will not: that both sides carry the same set of strings.
 */

/**
 * Every Prisma enum, mapped to the shared values it must match.
 *
 * Several Prisma enums map onto one shared enum. That is not an error: Postgres has one physical
 * type per column that declares an enum, while shared models the concept once — a thread's origin
 * and a job's origin are the same idea stored twice. Prisma names its type after the physical one,
 * so the names differ even though the values cannot.
 */
const EXPECTED_VALUES: Record<keyof typeof prismaEnums, readonly string[]> = {
  EAgentCredentialKind: Object.values(EAgentCredentialKind),
  EAgentCredentialStatus: Object.values(EAgentCredentialStatus),
  EAgentProvider: Object.values(EAgentProvider),
  // Predates the E-enum convention and stayed a const tuple; the parity requirement is the same.
  EAutoMergeMethod: AUTO_MERGE_METHODS,
  EInboundMessageSource: Object.values(EThreadMessageSource),
  EInboundMessageStatus: Object.values(EInboundMessageStatus),
  EInboundPriority: Object.values(EInboundPriority),
  EJobKind: Object.values(EJobKind),
  EJobOrigin: Object.values(EThreadOrigin),
  EJobStatus: Object.values(EJobStatus),
  EMessageAudience: Object.values(EMessageAudience),
  EMountMode: Object.values(EMountMode),
  EOrgRole: Object.values(EOrgRole),
  EOrgStatus: Object.values(EOrgStatus),
  ESubagentStatus: Object.values(ESubagentStatus),
  ETaskStatus: Object.values(ETaskStatus),
  EThreadCondition: Object.values(EThreadCondition),
  EThreadGroupCondition: Object.values(EThreadCondition),
  EThreadGroupKind: Object.values(EThreadGroupKind),
  EThreadGroupStatus: Object.values(EThreadStatus),
  EThreadMessageSource: Object.values(EThreadMessageSource),
  // Shared splits this deliberately into inbound and output halves plus a union type; the database
  // stores one enum, so the runtime list is what has to line up.
  EThreadMessageType: THREAD_MESSAGE_TYPE_VALUES,
  EThreadRole: Object.values(EThreadRole),
  EThreadStatus: Object.values(EThreadStatus),
  EThreadType: Object.values(EThreadType),
  EUserRole: Object.values(EUserRole),
  EUserStatus: Object.values(EUserStatus),
};

const sorted = (values: readonly string[]): string[] => [...values].map(String).sort();

describe('Prisma ↔ shared enum parity', () => {
  const generated = Object.keys(prismaEnums).filter(
    (key) => typeof (prismaEnums as Record<string, unknown>)[key] === 'object',
  );

  it('maps every generated enum', () => {
    // A new enum in the schema with no entry above fails here rather than silently going unchecked.
    expect(generated.filter((name) => !(name in EXPECTED_VALUES))).toEqual([]);
  });

  it('has no stale entries', () => {
    // A renamed or deleted Prisma enum leaves an entry pointing at nothing.
    expect(Object.keys(EXPECTED_VALUES).filter((name) => !generated.includes(name))).toEqual([]);
  });

  it.each(Object.keys(EXPECTED_VALUES))('%s carries the same values as shared', (name) => {
    const actual = Object.values(
      (prismaEnums as Record<string, Record<string, string>>)[name] ?? {},
    );
    expect(sorted(actual)).toEqual(sorted(EXPECTED_VALUES[name as keyof typeof EXPECTED_VALUES]));
  });
});
