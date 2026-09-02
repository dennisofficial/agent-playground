import { z } from 'zod'

import { threadIdSchema } from '../../events/ids'
import { EToolEffect } from '../../tools/tool'
import { EReadConfidence } from './command/read-command'
import { EDeed, EDeedRealm, type Deed } from './deed'
import { ERiskDimension } from './dimension'
import type { CallEvidence } from './evidence'
import { EOccupancy, type WorkspaceFacts, type WorktreeFact } from './facts'
import { EGrantScope } from './grant'

const texts = z.array(z.string())

const maybeText = z.string().optional()

const maybeCount = z.number().int().optional()

const deedTargetSchema = z.object({ realm: z.enum(EDeedRealm), value: z.string() })

const deedSchema = z
  .object({
    action: z.enum(EDeed),
    toolName: z.string(),
    targets: z.array(deedTargetSchema),
    cwd: maybeText,
    summary: z.string(),
  })
  .transform((deed): Deed => ({ ...deed, cwd: deed.cwd }))

const segmentSchema = z
  .object({
    program: z.string(),
    verb: maybeText,
    flags: texts,
    operands: texts,
    rawOperands: texts,
    cwd: maybeText,
    redirectsInto: texts,
    pipesIntoInterpreter: z.boolean(),
    unresolvedExpansions: texts,
  })
  .transform((segment) => ({ ...segment, verb: segment.verb, cwd: segment.cwd }))

const readingSchema = z.object({
  confidence: z.enum(EReadConfidence),
  segments: z.array(segmentSchema),
  command: z.string().default(''),
})

const worktreeFactSchema = z
  .object({
    path: z.string(),
    branch: maybeText,
    isMain: z.boolean(),
    occupancy: z.enum(EOccupancy),
    heldBy: maybeCount,
    changedCount: maybeCount,
    unpushedCommits: maybeCount,
  })
  .transform((worktree): WorktreeFact => ({
    ...worktree,
    branch: worktree.branch,
    heldBy: worktree.heldBy,
    changedCount: worktree.changedCount,
    unpushedCommits: worktree.unpushedCommits,
  }))

const refFactSchema = z.object({
  ref: z.string(),
  onRemote: z.boolean(),
  checkedOutAt: texts,
})

const factsSchema = z
  .object({
    projectDirectory: z.string(),
    launchDirectory: z.string(),
    repo: maybeText,
    worktrees: z.array(worktreeFactSchema),
    refs: z.array(refFactSchema),
    ownChangedPaths: texts,
    regenerablePaths: texts,
    gatheredFor: z.array(z.enum(EDeedRealm)),
  })
  .transform((facts): WorkspaceFacts => ({ ...facts, repo: facts.repo }))

const recentActSchema = z.object({
  name: z.string(),
  effect: z.enum(EToolEffect),
  deeds: z.array(z.enum(EDeed)),
  ingestedUntrustedContent: z.boolean(),
  readSecretShapedPath: z.boolean(),
})

const utteranceSchema = z.object({ text: z.string(), seq: z.number().int() })

const grantSchema = z.object({
  grantId: z.string(),
  dimensions: z.array(z.enum(ERiskDimension)),
  scope: z.enum(EGrantScope),
  subject: z.string(),
  reason: z.string(),
  seq: z.number().int(),
})

export const callEvidenceSchema = z
  .object({
    deeds: z.array(deedSchema),
    toolName: z.string(),
    effect: z.enum(EToolEffect),
    threadId: threadIdSchema,
    reading: readingSchema.optional(),
    facts: factsSchema,
    recent: z.array(recentActSchema),
    said: z.array(utteranceSchema),
    grants: z.array(grantSchema),
  })
  .transform((evidence): CallEvidence => ({ ...evidence, reading: evidence.reading }))
