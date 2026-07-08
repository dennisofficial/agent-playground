/**
 * prompt-kit / groups — the topic-bucketed `@FragmentGroup` classes that make up the ATLAS_MAIN (brain)
 * prompt, plus the composed-tail groups (job-kind block + behavioral notes) and the operator group.
 *
 * `FRAGMENT_GROUPS` is registered as plain class providers by `PromptKitModule` so `DiscoveryService` can
 * find them at boot. Adding a new group = add its class here.
 */
import { IdentityGroup } from './identity.group';
import { SandboxGroup } from './sandbox.group';
import { HostToolsGroup } from './host-tools.group';
import { OrientationGroup } from './orientation.group';
import { ConversationGroup } from './conversation.group';
import { ContextGroup } from './context.group';
import { PlanningGroup } from './planning.group';
import { TaskListGroup } from './task-list.group';
import { EnvironmentGroup } from './environment.group';
import { SafetyGroup } from './safety.group';
import { JobKindGroup } from './job-kind.group';
import { BehavioralGroup } from './behavioral.group';
import { OperatorGroup } from './operator.group';
import { ConventionsGroup } from './conventions.group';
import { DriverFramingGroup } from './driver-framing.group';
import { WorkerGroup } from './worker.group';
import { ShipGroup } from './ship.group';
import { AutofixGroup } from './autofix.group';
import { MetaGroup } from './meta.group';
import { SubagentsGroup } from './subagents.group';
import { ReviewGroup } from './review.group';

export const FRAGMENT_GROUPS = [
  // Brain (ATLAS_MAIN)
  IdentityGroup,
  SandboxGroup,
  HostToolsGroup,
  OrientationGroup,
  ReviewGroup,
  ConversationGroup,
  ContextGroup,
  PlanningGroup,
  TaskListGroup,
  EnvironmentGroup,
  SafetyGroup,
  JobKindGroup,
  BehavioralGroup,
  OperatorGroup,
  ConventionsGroup,
  // Driver / ship / autofix / meta / subagents
  DriverFramingGroup,
  WorkerGroup,
  ShipGroup,
  AutofixGroup,
  MetaGroup,
  SubagentsGroup,
] as const;

export {
  IdentityGroup,
  SandboxGroup,
  HostToolsGroup,
  OrientationGroup,
  ReviewGroup,
  ConversationGroup,
  ContextGroup,
  PlanningGroup,
  TaskListGroup,
  EnvironmentGroup,
  SafetyGroup,
  JobKindGroup,
  BehavioralGroup,
  OperatorGroup,
  ConventionsGroup,
  DriverFramingGroup,
  WorkerGroup,
  ShipGroup,
  AutofixGroup,
  MetaGroup,
  SubagentsGroup,
};
