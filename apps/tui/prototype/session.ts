// PROTOTYPE — throwaway. The fake session every direction is drawn against.

import { toThreadId, type ThreadId } from '@dltech/atlas-core'

import { modelLabel } from '../src/ui/model-label'
import { collapseHome } from '../src/ui/paths'

export const CWD = process.cwd()

export const HOME = process.env.HOME ?? ''

export const MODEL_ID = 'claude-opus-5'

export const THREAD: ThreadId = toThreadId('a1b2c3d4-prototype')

const THREAD_CHARS = 8

export const WHERE = collapseHome({ cwd: CWD, home: HOME })

export const MODEL = modelLabel(MODEL_ID)

export const THREAD_LABEL = `thread ${String(THREAD).slice(0, THREAD_CHARS)}`
