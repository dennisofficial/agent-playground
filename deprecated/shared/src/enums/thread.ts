export enum EThreadOrigin {
  CHAT = 'chat',
  EVENT = 'event',
  CONTROL = 'control',
}

export enum EThreadStatus {
  PENDING = 'pending',
  PLANNING = 'planning',
  REVIEWING = 'reviewing',
  EXECUTING = 'executing',
  AUTO_FIXING = 'auto_fixing',
  DONE = 'done',
}

export enum EThreadCondition {
  NONE = 'none',
  PAUSED = 'paused', // a mid-build pause (request_operator_input / thread-level approval)
  INCOMPLETE = 'incomplete', // halted without asserting completion
  FAILED = 'failed', // crashed / errored out
  SKIPPED = 'skipped', // a review child that had nothing to do — terminal, not a failure
}

export enum EStepStatus {
  PENDING = 'pending',
  BUILDING = 'building',
  REVIEWING = 'reviewing',
  DONE = 'done',
}

export enum EThreadRole {
  PLANNING = 'planning',
  PLAN_REVIEW = 'plan_review',
  BUILDER = 'builder',
  REVIEW_AGENT = 'review_agent',
  REVIEW_FIX = 'review_fix',
  MASTER_REVIEW = 'master_review',
  POST_BUILD = 'post_build',
  CI = 'ci',
}

export enum EThreadType {
  BACKEND = 'backend',
  FRONTEND = 'frontend',
  DOCS = 'docs',
  TESTING = 'testing',
  INFRA = 'infra',
  DATA = 'data',
  GENERAL = 'general',
}

export enum EThreadGroupKind {
  PLANNING = 'planning',
  PLAN_REVIEW = 'plan_review',
  BUILD = 'build',
  DIRECT_BUILD = 'direct_build',
  MASTER_REVIEW = 'master_review',
  POST_BUILD = 'post_build',
  CI = 'ci',
}
