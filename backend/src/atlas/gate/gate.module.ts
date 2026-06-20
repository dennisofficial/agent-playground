import { Module } from '@nestjs/common';
import { RunnerModule } from '../runner';
import { SurfaceModule } from '../surface';
import { AcceptanceGateService } from './acceptance-gate.service';

/**
 * The W1 acceptance-GATE module — composes the substrate the gate exercises (RunnerModule = engine +
 * git; SurfaceModule = the Slack surface) and provides `AcceptanceGateService`. Lightweight: the gate
 * needs only the local substrate + surface, NOT the persistence/datasource (it never touches
 * atlas_phases), so it can boot fast for a scripted run. Zero v1 imports.
 */
@Module({
  imports: [RunnerModule, SurfaceModule],
  providers: [AcceptanceGateService],
  exports: [AcceptanceGateService],
})
export class GateModule {}
