import React from "react";
import { PageHeader } from "./page-header.js";

export function Breadcrumb(props: {
  project: string;
  job: string;
  role: string;
  sessionOrdinal: number;
  engine: string;
  model: string;
  width: number;
  readOnly?: boolean;
}): React.ReactNode {
  const trail = [
    props.project,
    props.job,
    props.sessionOrdinal > 1
      ? `${props.role} · session ${props.sessionOrdinal}`
      : props.role,
  ];

  return (
    <PageHeader
      trail={trail}
      right={`${props.readOnly ? "read-only  " : ""}${props.engine} ${props.model}`}
      width={props.width}
      canBack
    />
  );
}
