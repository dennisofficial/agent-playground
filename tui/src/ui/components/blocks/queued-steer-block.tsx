import React from "react";
import { UserBlock } from "./user-block.js";

/**
 * How far a waiting message sits in from the transcript's left edge. Two columns: enough that the
 * eye reads it as parked rather than posted, not so much that it stops lining up with the messages
 * it is about to join.
 */
const QUEUE_INSET = 2;

/**
 * A steer the model has not taken yet, drawn exactly as it will be drawn once it has.
 *
 * The whole point is that it is `UserBlock` and not a lookalike. This block has one job — to be the
 * message the human just wrote — and it has that job twice: once parked under the working line, once
 * committed in the transcript. Two renderers for one thing means the queued copy quietly drifts from
 * the real one, and the moment it does, the transition from waiting to sent stops reading as the SAME
 * message moving and starts reading as one thing disappearing and another appearing.
 *
 * So the only difference is where it sits. It is indented, and it is below the working line rather
 * than above it — position is the whole of the "not yet" signal, which is the right amount, because
 * the alternative is styling a message to look provisional and then having to un-style it in place.
 *
 * It stops being drawn here when `input_ack` arrives (see `turn-events.ts`) — the moment the model
 * actually read it, not the moment Atlas sent it.
 */
export function QueuedSteerBlock(props: {
  text: string;
  width: number;
}): React.ReactNode {
  return (
    <box flexDirection="column" paddingLeft={QUEUE_INSET}>
      {/* The inset comes off the width rather than being ignored by it: `UserBlock` wraps markdown
          against a hard column count, so a body measured at the full width would run its last cell
          into the scroll track. */}
      <UserBlock text={props.text} width={props.width - QUEUE_INSET} />
    </box>
  );
}
