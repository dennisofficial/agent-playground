import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { AdminUser } from '@workspace/shared/schemas';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminUserStore } from './admin-user.store';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@CreateModule({
  imports: [TypeOrmModule.forFeature([AdminUser])],
  controllers: [AuthController],
  services: [AdminUserStore, AuthService, AdminAuthGuard],
})
export class AuthModule {}
