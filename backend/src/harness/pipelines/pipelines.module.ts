import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { featurePipeline } from './definitions/feature.pipeline';
import { PipelineRegistry } from './pipeline.registry';
import { PIPELINE_DEFINITIONS } from './pipeline.types';

/**
 * The declarative pipeline layer. Pipelines are DATA — an ordered list of stages held in a
 * boot-validated registry and walked by a generic interpreter (PipelineRunnerService, in
 * SessionsModule). Adding/removing/editing a pipeline is editing the bound PIPELINE_DEFINITIONS
 * list, never the runner. Bind code-declared definitions here; a future DB-backed source can swap in
 * behind the same token.
 */
@CreateModule({
  imports: [EmployeesModule],
  services: [
    { provide: PIPELINE_DEFINITIONS, useValue: [featurePipeline] },
    PipelineRegistry,
  ],
})
export class PipelinesModule {}
