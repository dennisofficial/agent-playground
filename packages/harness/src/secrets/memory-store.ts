import type { SecretsPort } from '@dltech/atlas-core'


export class MemorySecretsStore implements SecretsPort {
  private held: Record<string, string>

  constructor(private readonly args: { label?: string; secrets?: Record<string, string> } = {}) {
    this.held = { ...args.secrets }
  }

  origin(): string {
    return this.args.label ?? 'memory'
  }

  read(name: string): string | undefined {
    return this.held[name]
  }

  write(written: { name: string; value: string }): void {
    this.held = { ...this.held, [written.name]: written.value }
  }

  remove(name: string): void {
    const rest = { ...this.held }
    delete rest[name]
    this.held = rest
  }
}
