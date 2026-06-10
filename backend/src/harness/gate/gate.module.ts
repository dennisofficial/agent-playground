import { CreateModule } from '@workspace/nestjs-core';
import { EmployeesModule } from '../employees/employees.module';
import { LlmModule } from '../llm/llm.module';
import { GateService } from './gate.service';

/** The response gate: hard addressing rules + the soft Haiku read-the-room classifier. */
@CreateModule({
  imports: [EmployeesModule, LlmModule],
  services: [GateService],
})
export class GateModule {}
