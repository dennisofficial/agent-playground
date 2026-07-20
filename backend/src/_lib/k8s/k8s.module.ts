import { Global } from '@nestjs/common';
import { CreateModule } from '@workspace/nestjs-core';
import { K8sService } from './k8s.service';

@Global()
@CreateModule({
  services: [K8sService],
})
export class K8sModule {}
