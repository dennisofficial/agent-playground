import { Injectable } from '@nestjs/common';

@Injectable()
export class SandboxActivityRegistry {
  private readonly inFlight = new Map<string, number>();

  enter(containerId: string): void {
    this.inFlight.set(containerId, (this.inFlight.get(containerId) ?? 0) + 1);
  }

  leave(containerId: string): void {
    const n = (this.inFlight.get(containerId) ?? 0) - 1;
    if (n > 0) this.inFlight.set(containerId, n);
    else this.inFlight.delete(containerId);
  }

  isBusy(containerId: string): boolean {
    return (this.inFlight.get(containerId) ?? 0) > 0;
  }

  async thread<T>(containerId: string, fn: () => Promise<T>): Promise<T> {
    this.enter(containerId);
    try {
      return await fn();
    } finally {
      this.leave(containerId);
    }
  }
}
