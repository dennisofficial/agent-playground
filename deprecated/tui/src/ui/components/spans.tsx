import React from "react";
import type { Span } from "../meter-style.js";

export function Spans(props: { spans: Span[] }): React.ReactNode {
  return (
    <>
      {props.spans.map((span, index) => (
        <span key={index} fg={span.fg}>
          {span.text}
        </span>
      ))}
    </>
  );
}
