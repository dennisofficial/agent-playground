/**
 * Returns the host process uid:gid string used to exec turns inside containers so that files written
 * to the bind-mounted worktree stay host-owned (not root-owned). Returns `undefined` on platforms
 * where `process.getuid`/`process.getgid` are not available (e.g. Windows).
 */
export function hostExecUser(): string | undefined {
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid =
    typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
}
