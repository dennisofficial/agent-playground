import React, { type ReactNode } from "react";

export function Screen(props: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}): React.ReactNode {
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      {props.header ? (
        <box flexDirection="row" flexShrink={0}>
          {props.header}
        </box>
      ) : null}

      <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
        {props.children}
      </box>

      {props.footer ? (
        <box flexDirection="row" flexShrink={0}>
          {props.footer}
        </box>
      ) : null}
    </box>
  );
}
