import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AcceptanceGateService } from './acceptance-gate.service';
import { GateRootModule } from './gate-root.module';

/**
 * Gate-root DI guard. `gate-main.ts` boots `GateRootModule` via `NestFactory.createApplicationContext`
 * — a DIFFERENT composition root than `AppModule` (which `boot.int.test.ts` covers). When the
 * gate was decoupled from `SurfaceModule` (it no longer posts to any chat surface), this test guards
 * against a regression: importing `SurfaceModule` here would pull in `WebSurfaceModule` → which injects
 * `DecisionApprovalService` + `DriverStoreService`, modules the gate root does NOT provide → a DI error
 * that `typecheck` cannot catch. Booting the root proves the graph resolves.
 */
describe('GateRootModule boot (standalone gate DI assembly, live Postgres)', () => {
  it('resolves AcceptanceGateService with no surface/brain/driver dependency', async () => {
    const app = await NestFactory.createApplicationContext(GateRootModule, {
      abortOnError: false,
    });
    app.enableShutdownHooks();
    try {
      expect(app.get(AcceptanceGateService)).toBeDefined();
    } finally {
      await app.close();
    }
  }, 60_000);
});
