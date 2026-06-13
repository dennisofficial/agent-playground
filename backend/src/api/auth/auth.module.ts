import { APP_GUARD } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { AdminUser } from '@workspace/shared/schemas';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminUserRepo } from './admin-user.repo';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@CreateModule({
  entities: [{ entity: AdminUser, repoClass: AdminUserRepo }],
  controllers: [AuthController],
  services: [AuthService],
  providers: [{ provide: APP_GUARD, useClass: AdminAuthGuard }],
})
export class AuthModule {}
