const BLOCK = 512

// POSIX ustar header layout — https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06
const FIELD = {
  name: { offset: 0, length: 100 },
  mode: { offset: 100, length: 8 },
  uid: { offset: 108, length: 8 },
  gid: { offset: 116, length: 8 },
  size: { offset: 124, length: 12 },
  mtime: { offset: 136, length: 12 },
  checksum: { offset: 148, length: 8 },
  typeflag: { offset: 156, length: 1 },
  linkname: { offset: 157, length: 100 },
  magic: { offset: 257, length: 8 },
  prefix: { offset: 345, length: 155 },
} as const

const writeOctal = (args: { target: Uint8Array; offset: number; length: number; value: number }): void => {
  const text = args.value.toString(8).padStart(args.length - 1, '0')
  for (let index = 0; index < text.length; index += 1) {
    args.target[args.offset + index] = text.charCodeAt(index)
  }
}

const writeText = (args: { target: Uint8Array; offset: number; length: number; value: string }): void => {
  const bytes = new TextEncoder().encode(args.value)
  args.target.set(bytes.subarray(0, args.length - 1), args.offset)
}

const splitName = (name: string): { name: string; prefix: string } => {
  if (name.length <= FIELD.name.length) return { name, prefix: '' }
  const cut = name.lastIndexOf('/', FIELD.prefix.length)
  if (cut < 0) throw new Error(`tar entry name too long for ustar: ${name.slice(0, 40)}…`)
  const prefix = name.slice(0, cut)
  const leaf = name.slice(cut + 1)
  if (prefix.length > FIELD.prefix.length || leaf.length > FIELD.name.length) {
    throw new Error(`tar entry name too long for ustar: ${name.slice(0, 40)}…`)
  }
  return { name: leaf, prefix }
}

export enum ETarEntryKind {
  File = '0',
  Directory = '5',
  Symlink = '2',
}

export type TarEntry = {
  name: string
  kind?: ETarEntryKind
  mode?: number
  body?: Uint8Array
  linkname?: string
}

const header = (entry: Required<Pick<TarEntry, 'kind'>> & TarEntry & { size: number }): Uint8Array => {
  const block = new Uint8Array(BLOCK)
  const { name, prefix } = splitName(entry.name)
  writeText({ target: block, ...FIELD.name, value: name })
  writeOctal({ target: block, ...FIELD.mode, value: entry.mode ?? 0o644 })
  writeOctal({ target: block, ...FIELD.uid, value: 0 })
  writeOctal({ target: block, ...FIELD.gid, value: 0 })
  writeOctal({ target: block, ...FIELD.size, value: entry.size })
  writeOctal({ target: block, ...FIELD.mtime, value: 0 })
  block.fill(0x20, FIELD.checksum.offset, FIELD.checksum.offset + FIELD.checksum.length)
  block[FIELD.typeflag.offset] = entry.kind.charCodeAt(0)
  if (entry.linkname !== undefined) writeText({ target: block, ...FIELD.linkname, value: entry.linkname })
  block.set(new TextEncoder().encode('ustar\x0000'), FIELD.magic.offset)
  writeText({ target: block, ...FIELD.prefix, value: prefix })
  let checksum = 0
  for (const byte of block) checksum += byte
  const text = checksum.toString(8).padStart(FIELD.checksum.length - 2, '0')
  for (let index = 0; index < text.length; index += 1) {
    block[FIELD.checksum.offset + index] = text.charCodeAt(index)
  }
  block[FIELD.checksum.offset + FIELD.checksum.length - 2] = 0
  block[FIELD.checksum.offset + FIELD.checksum.length - 1] = 0x20
  return block
}

export function tarEntries(args: { entries: readonly TarEntry[] }): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  for (const entry of args.entries) {
    const kind = entry.kind ?? ETarEntryKind.File
    const body = kind === ETarEntryKind.File ? (entry.body ?? new Uint8Array(0)) : new Uint8Array(0)
    parts.push(header({ ...entry, kind, size: body.length }))
    if (kind !== ETarEntryKind.File) continue
    parts.push(body)
    const remainder = body.length % BLOCK
    if (remainder !== 0) parts.push(new Uint8Array(BLOCK - remainder))
  }
  parts.push(new Uint8Array(BLOCK * 2))

  const archive = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    archive.set(part, offset)
    offset += part.length
  }
  return archive
}
