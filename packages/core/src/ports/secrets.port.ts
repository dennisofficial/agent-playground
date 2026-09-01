export abstract class SecretsPort {
  abstract origin(): string
  abstract read(name: string): string | undefined
  abstract write(args: { name: string; value: string }): void
  abstract remove(name: string): void
}
