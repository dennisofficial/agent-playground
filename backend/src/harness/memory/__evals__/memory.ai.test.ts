import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { EnvModule } from '@workspace/nestjs-core';
import { Fact } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../../../_lib/database/database.module';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { MemoryModule } from '../memory.module';
import { MemoryWriteService } from '../memory-write.service';
import { ReconcileService } from '../reconcile.service';
import { SemanticMemory } from '../semantic-memory';
import {
  type EvalDeps,
  formatSummary,
  loadCases,
  runEvals,
} from './eval-runner';

/**
 * The memory eval, run for real (LLM extraction + OpenAI embeddings + live Postgres). This is the
 * BASELINE measurement that every later memory change is graded against — it PRINTS a numbers table
 * and asserts only that the harness ran end-to-end, never a quality bar (Phase 1 is measurement;
 * thresholds arrive once the consolidation pass lands). Run with: pnpm test:ai
 */
const hasKeys = !!process.env.ANTHROPIC_API_KEY && !!process.env.OPENAI_API_KEY;

describe.skipIf(!hasKeys)('Memory eval (real LLM + pgvector)', () => {
  let app: TestingModule;
  let deps: EvalDeps;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      imports: [
        EnvModule.forRoot({
          envService: EnvService,
          validationSchema: envConfigValidation,
        }),
        DatabaseModule,
        MemoryModule,
      ],
    }).compile();
    await app.init();
    deps = {
      semantic: app.get(SemanticMemory),
      writes: app.get(MemoryWriteService),
      reconcile: app.get(ReconcileService),
      facts: app.get<Repository<Fact>>(getRepositoryToken(Fact)),
      employees: app.get(EmployeeRegistry),
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  it('measures extraction + recall quality across the case set', async () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThan(0);

    const summary = await runEvals(cases, deps);
    // The deliverable: a comparable report in the test output.
    console.log(`\n${formatSummary(summary)}\n`);

    // Sanity only — the harness executed every case and produced metrics. No quality gate yet.
    expect(summary.results.length).toBe(cases.length);
    expect(Number.isFinite(summary.extraction.meanRecall)).toBe(true);
    expect(Number.isFinite(summary.recall.meanHitRate)).toBe(true);
  });
});
