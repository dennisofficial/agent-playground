import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ATLAS_SVC_NAME = 'atlas-svc'

const SHIM = `#!/usr/bin/env bash
set -euo pipefail

services_dir="\${ATLAS_HOME:-\$HOME/.atlas}/services"

usage() {
  echo "usage: atlas-svc ls | atlas-svc path <service-id> | atlas-svc logs <service-id> [tail flags, e.g. -n 200 -f]" >&2
  exit 2
}

resolve() {
  local id="$1"
  local found
  found=$(ls -t "$services_dir/$id".*.log 2>/dev/null | head -n 1 || true)
  if [[ -z "$found" ]]; then
    echo "atlas-svc: no log for service \\"$id\\" under $services_dir" >&2
    exit 1
  fi
  printf '%s\\n' "$found"
}

case "\${1:-}" in
  ls)
    ls -t "$services_dir"/*.log 2>/dev/null | sed -e 's|.*/||' -e 's|\\.log$||' -e 's|\\.[^.]*$||' | uniq || true
    ;;
  path)
    [[ $# -ge 2 ]] || usage
    resolve "$2"
    ;;
  logs)
    [[ $# -ge 2 ]] || usage
    id="$2"
    shift 2
    exec tail "$@" "$(resolve "$id")"
    ;;
  *)
    usage
    ;;
esac
`

/**
 * The registry lives in this process's memory, so nothing outside it can query services — but a
 * log is a file, and a file is all a pipeline needs. The shim is therefore stateless: it resolves
 * an id to the newest matching log (the token suffix keeps two live sessions' svc_1 apart, and the
 * one the model just started is always the newest) and execs tail, so -n and -f pass straight
 * through into whatever pipe the model builds.
 */
export function ensureAtlasSvcShim(args: { binDirectory: string }): string {
  const path = join(args.binDirectory, ATLAS_SVC_NAME)
  mkdirSync(args.binDirectory, { recursive: true })

  if (existsSync(path) && readFileSync(path, 'utf8') === SHIM) return path

  writeFileSync(path, SHIM)
  chmodSync(path, 0o755)
  return path
}

/**
 * A shim that cannot be written (a read-only home) must not take boot down with it: every reply
 * that mentions atlas-svc also names the log's absolute path, so the model loses a convenience,
 * not the output.
 */
export function tryEnsureAtlasSvcShim(args: { binDirectory: string }): string | undefined {
  try {
    return ensureAtlasSvcShim(args)
  } catch {
    return undefined
  }
}
