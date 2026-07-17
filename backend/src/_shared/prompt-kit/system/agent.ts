export enum Agent {
  PLANNING = 'atlas_main',
  POST_BUILD = 'post_build',
  CI = 'ci',
  WORKER = 'worker',
  FAN_OUT = 'fan_out',
  EXPLORE = 'explore',
  DOCS = 'docs',
  REVIEW_AGENT = 'review_agent',
  DEBUG = 'debug',
  TEST = 'test',
  VALIDATE = 'validate',
  PROTOTYPE = 'prototype',
  MASTER_REVIEW = 'master_review',
  AUTOFIX_REVIEW = 'autofix_review',
  AUTOFIX_FIX = 'autofix_fix',
  META_PLAN_REVIEW = 'meta_plan_review',
}

export const ALL: Agent[] = Object.values(Agent);

export const ENGINEERING_STAGES: Agent[] = [Agent.PLANNING, Agent.POST_BUILD, Agent.CI];

export const SHIP_STAGES: Agent[] = [Agent.POST_BUILD, Agent.CI];

export const BUILDERS: Agent[] = [Agent.WORKER, Agent.FAN_OUT];

export const EVIDENCE_OWNERS: Agent[] = [Agent.WORKER, Agent.VALIDATE];

export const ADVISORY: Agent[] = [
  Agent.EXPLORE,
  Agent.DOCS,
  Agent.REVIEW_AGENT,
  Agent.DEBUG,
  Agent.TEST,
];

export const ENGINE_SUBAGENTS: Agent[] = [
  ...ADVISORY,
  Agent.VALIDATE,
  Agent.FAN_OUT,
  Agent.PROTOTYPE,
];

export const REVIEWERS: Agent[] = [Agent.REVIEW_AGENT, Agent.MASTER_REVIEW];
