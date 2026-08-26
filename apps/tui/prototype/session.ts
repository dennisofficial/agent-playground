// PROTOTYPE — throwaway. The fake session every direction is drawn against.

import { toBranchId, type BranchId } from '@dltech/atlas-core'

import { modelLabel } from '../src/ui/model-label'
import { collapseHome } from '../src/ui/paths'

export const CWD = process.cwd()

export const HOME = process.env.HOME ?? ''

export const MODEL_ID = 'claude-opus-5'

export const BRANCH: BranchId = toBranchId('a1b2c3d4-prototype')

const BRANCH_CHARS = 8

export const WHERE = collapseHome({ cwd: CWD, home: HOME })

export const MODEL = modelLabel(MODEL_ID)

export const BRANCH_LABEL = `branch ${String(BRANCH).slice(0, BRANCH_CHARS)}`
