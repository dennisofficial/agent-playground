
export function fence(tag: string, body: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const safe = body.split(open).join('').split(close).join('');
  return `${open}\n${safe}\n${close}`;
}

export function fenceOrNone(tag: string, body: string | null | undefined): string {
  return fence(tag, (body ?? '').trim() || '(none)');
}
