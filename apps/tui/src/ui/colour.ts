function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

export function mixHex(args: { from: string; to: string; amount: number }): string {
  const t = Math.max(0, Math.min(1, args.amount))
  const [fromRed, fromGreen, fromBlue] = channels(args.from)
  const [toRed, toGreen, toBlue] = channels(args.to)
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(fromRed, toRed)}${channel(fromGreen, toGreen)}${channel(fromBlue, toBlue)}`
}
