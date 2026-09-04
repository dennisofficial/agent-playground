import { homedir } from "node:os";

import { RGBA } from "@opentui/core";
import React from "react";

import { collapseHome, compactPath } from "../paths";
import { theme } from "../theme";
import type { ServiceSnapshot, ShellSnapshot } from "@dltech/atlas-harness";

import type { SidebarModel } from "../../store";
import type { SidebarCrewFold } from "../../store/subagent-row";
import { SIDEBAR_GUTTER, SIDEBAR_PADDING, sidebarCells } from "./sidebar/cells";
import { ESidebarPlace } from "../sidebar-section";
import { ContributedSections } from "./sidebar/contributed";
import { SubagentsSection, TeammatesSection } from "./sidebar/crew";
import { GrantsSection } from "./sidebar/grants";
import { HeadSection } from "./sidebar/head";
import { ServicesSection } from "./sidebar/services";
import { ShellsSection } from "./sidebar/shells";
import { TodoSection } from "./sidebar/todo";
import { useRelaxedThumb } from "../scrollbar-thumb";

const worktreeLabel = (args: { worktree: string; root: string }): string =>
  args.worktree.startsWith(`${args.root}/`)
    ? args.worktree.slice(args.root.length + 1)
    : collapseHome({ cwd: args.worktree, home: homedir() });

function SidebarFooter(props: {
  root: string;
  worktree: string | null;
  cells: number;
}): React.ReactNode {
  const where = collapseHome({ cwd: props.root, home: homedir() });

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingTop={1}
      paddingRight={SIDEBAR_GUTTER}
    >
      <text fg={theme.dim}>
        {compactPath({ path: where, cells: props.cells })}
      </text>
      {props.worktree === null ? null : (
        <text fg={theme.meta}>
          {compactPath({
            path: worktreeLabel({ worktree: props.worktree, root: props.root }),
            cells: props.cells,
          })}
        </text>
      )}
      <text>
        <span fg={theme.accent}>● </span>
        <span fg={theme.hover}>atlas</span>
      </text>
    </box>
  );
}

const SCRIM = RGBA.fromInts(0, 0, 0, 70);

/**
 * The scrim is the floating sidebar's sibling rather than its parent so that folding and unfolding
 * never re-parents the panel, which would remount the scrollbox and lose where it was scrolled to.
 */
function Scrim(): React.ReactNode {
  return (
    <box
      position="absolute"
      zIndex={19}
      top={0}
      bottom={0}
      left={0}
      right={0}
      backgroundColor={SCRIM}
    />
  );
}

/**
 * Every positioning prop is passed on every render rather than spread in only while floating:
 * OpenTUI's reconciler applies the props an element carries and leaves a prop that disappeared
 * from it at its last value, so a sidebar that stopped floating would stay out of the flow and
 * the transcript would keep the whole terminal and draw underneath it.
 */
export function Sidebar(props: {
  width: number;
  model: SidebarModel;
  root: string;
  worktree: string | null;
  overlay?: boolean;
  shells?: readonly ShellSnapshot[];
  shellNow?: number;
  shellFold?: SidebarCrewFold;
  services?: readonly ServiceSnapshot[];
  serviceNow?: number;
  serviceFold?: SidebarCrewFold;
  onOpenShell?: (shellId: string) => void;
  onOpenService?: (serviceId: string) => void;
  onSelectSubagent?: (agentId: string) => void;
  onRevokeGrant?: (grantId: string) => void;
}): React.ReactNode {
  const { model } = props;
  const cells = sidebarCells({ width: props.width });
  const floating = props.overlay === true;
  const attachThumb = useRelaxedThumb();

  return (
    <>
      {floating ? <Scrim /> : null}
      <box
        flexDirection="column"
        flexShrink={0}
        width={props.width}
        backgroundColor={theme.panelBg}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={SIDEBAR_PADDING}
        position={floating ? "absolute" : "relative"}
        zIndex={floating ? 20 : 0}
        top={0}
        bottom={0}
        right={0}
      >
        <scrollbox
          ref={attachThumb}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          contentOptions={{ paddingRight: SIDEBAR_PADDING }}
        >
          <box flexDirection="column" flexShrink={0} gap={1}>
            <HeadSection model={model} cells={cells} />
            <ContributedSections
              sections={model.sections ?? []}
              place={ESidebarPlace.Facts}
              cells={cells}
            />
            <ShellsSection
              shells={props.shells ?? []}
              now={props.shellNow ?? Date.now()}
              cells={cells}
              fold={props.shellFold}
              {...(props.onOpenShell === undefined
                ? {}
                : { onOpen: props.onOpenShell })}
            />
            <ServicesSection
              services={props.services ?? []}
              now={props.serviceNow ?? Date.now()}
              cells={cells}
              fold={props.serviceFold}
              {...(props.onOpenService === undefined
                ? {}
                : { onOpen: props.onOpenService })}
            />
            <GrantsSection
              grants={model.grants ?? []}
              cells={cells}
              {...(props.onRevokeGrant === undefined
                ? {}
                : { onRevoke: props.onRevokeGrant })}
            />
            <TodoSection tasks={model.todo ?? []} cells={cells} />
            <SubagentsSection
              subagents={model.subagents ?? []}
              cells={cells}
              fold={model.crewFold}
              {...(props.onSelectSubagent === undefined
                ? {}
                : { onOpen: props.onSelectSubagent })}
            />
            <TeammatesSection teammates={model.teammates ?? []} cells={cells} />
            <ContributedSections
              sections={model.sections ?? []}
              place={ESidebarPlace.Panels}
              cells={cells}
            />
          </box>
        </scrollbox>
        <SidebarFooter
          root={props.root}
          worktree={props.worktree}
          cells={cells}
        />
      </box>
    </>
  );
}
