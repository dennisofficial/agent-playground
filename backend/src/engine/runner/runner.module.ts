import { CreateModule } from "@workspace/nestjs-core";
import { RunnerService } from "./runner.service";

@CreateModule({
  providers: [RunnerService]
})
export class RunnerModule {}
