export async function digestOf({ path }: { path: string }): Promise<string | undefined> {
  try {
    return Bun.hash.wyhash(await Bun.file(path).arrayBuffer()).toString(16)
  } catch {
    return undefined
  }
}
