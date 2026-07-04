// The node-resolution logic now lives in the node registry (the single source of truth for node matching,
// placement, resolution, and lanes). Kept as a thin re-export so existing importers don't churn.
export { resolveNode, type NodeResolution } from "./node-registry";
