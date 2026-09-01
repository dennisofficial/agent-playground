const BULLET = '•'

const TAIL = 4

export const maskTypedSecret = (typed: string): string => {
  const held = [...typed]
  if (held.length <= TAIL) return BULLET.repeat(held.length)
  return `${BULLET.repeat(held.length - TAIL)}${held.slice(-TAIL).join('')}`
}

export const maskStoredSecret = (value: string): string => {
  const held = [...value]
  const tail = held.length <= TAIL ? '' : held.slice(-TAIL).join('')
  return `${BULLET.repeat(TAIL)}${tail}`
}
