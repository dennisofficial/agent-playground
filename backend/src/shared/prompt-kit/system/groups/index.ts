import { AutoMergeGroup } from './auto-merge.group';
import { AutofixGroup } from './autofix.group';
import { AutonomyGroup } from './autonomy.group';
import { BehavioralGroup } from './behavioral.group';
import { ContextGroup } from './context.group';
import { ConventionsGroup } from './conventions.group';
import { ConversationGroup } from './conversation.group';
import { DriverFramingGroup } from './driver-framing.group';
import { HostToolsGroup } from './host-tools.group';
import { IdentityGroup } from './identity.group';
import { JobKindGroup } from './job-kind.group';
import { MetaGroup } from './meta.group';
import { OperatorGroup } from './operator.group';
import { OrientationGroup } from './orientation.group';
import { PlanningGroup } from './planning.group';
import { ReviewGroup } from './review.group';
import { SafetyGroup } from './safety.group';
import { SandboxGroup } from './sandbox.group';
import { ShipGroup } from './ship.group';
import { SubagentsGroup } from './subagents.group';
import { TaskListGroup } from './task-list.group';
import { WorkerGroup } from './worker.group';
import { WorkspaceProfileGroup } from './workspace-profile.group';

export const FRAGMENT_GROUPS = [
  IdentityGroup,
  SandboxGroup,
  HostToolsGroup,
  OrientationGroup,
  ReviewGroup,
  ConversationGroup,
  ContextGroup,
  PlanningGroup,
  AutonomyGroup,
  AutoMergeGroup,
  TaskListGroup,
  WorkspaceProfileGroup,
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
] as const;

export {
  AutofixGroup,
  AutoMergeGroup,
  AutonomyGroup,
  BehavioralGroup,
  ContextGroup,
  ConventionsGroup,
  ConversationGroup,
  DriverFramingGroup,
  HostToolsGroup,
  IdentityGroup,
  JobKindGroup,
  MetaGroup,
  OperatorGroup,
  OrientationGroup,
  PlanningGroup,
  ReviewGroup,
  SafetyGroup,
  SandboxGroup,
  ShipGroup,
  SubagentsGroup,
  TaskListGroup,
  WorkerGroup,
  WorkspaceProfileGroup,
};
