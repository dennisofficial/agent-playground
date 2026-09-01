/**
 * Memory calls, named for what they are rather than for the file they touched.
 *
 * A memory is a file, so without this every recall reads `Read .atlas/memory/bun-deflate.md` and
 * every save reads `Wrote` the same path — the two operations a reader most wants to tell apart,
 * spelled identically and buried under a directory nobody needs to see. The classification is what
 * decides the prose, so naming them here is the whole change.
 */

import { isMemoryIndexPath, looksLikeMemoryPath, memoryNameOf } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../tool-runs'
import { EDetail, EGather, EToolClass, type Classification } from './kinds'
import { count, inputOf, lineCount, num, outputOf, str, targetOf } from './reading'

const INDEX = 'the memory index'

const pathOf = (args: { call: ToolCall; cwd: string }): string | undefined =>
  str(outputOf(args.call).path) ?? targetOf(args) ?? str(inputOf(args.call).path)

const subjectOf = (path: string): string =>
  isMemoryIndexPath(path) ? INDEX : (memoryNameOf(path) ?? path)

function recalled(args: { call: ToolCall; path: string }): Classification {
  const lines = num(outputOf(args.call).lines) ?? lineCount(args.call.modelText)
  const subject = subjectOf(args.path)

  return {
    klass: EToolClass.Gathered,
    gather: EGather.Recall,
    line: subject,
    alone: `Recalled ${subject}`,
    failed: false,
    note: `${count(lines)} l`,
    metric: lines,
    detail: EDetail.File,
  }
}

function saved(args: { call: ToolCall; path: string }): Classification {
  const output = outputOf(args.call)
  const subject = subjectOf(args.path)
  const created = output.created === true
  const index = isMemoryIndexPath(args.path)

  const verb = index ? 'Updated' : created ? 'Remembered' : 'Revised'
  const wrote = str(inputOf(args.call).content) !== undefined

  return {
    klass: EToolClass.Change,
    gather: null,
    line: `${verb} ${subject}`,
    failed: false,
    note: created ? 'new' : 'saved',
    metric: null,
    detail: wrote ? EDetail.Created : EDetail.None,
  }
}

export function memoryCall(args: { call: ToolCall; cwd: string }): Classification | null {
  const { call } = args
  if (call.state !== ECallState.Ok) return null

  const path = pathOf(args)
  if (path === undefined || !looksLikeMemoryPath(path)) return null

  if (call.name === 'read') return recalled({ call, path })
  if (call.name === 'write' || call.name === 'edit') return saved({ call, path })

  return null
}
