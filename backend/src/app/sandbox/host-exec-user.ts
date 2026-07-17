export function hostExecUser(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
}
