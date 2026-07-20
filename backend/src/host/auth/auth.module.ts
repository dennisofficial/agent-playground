import { EnvService } from '@core/config/env/env.service';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtModuleOptions } from '@workspace/auth/server';
import { CreateModule } from '@workspace/nestjs-core';
import { User, UserRepo } from '../../_lib/database/entities/user.entity';
import { OrgModule } from '../org/org.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@CreateModule({
  imports: [
    JwtModule.forRootAsync({
      isGlobal: true,
      inject: [EnvService],
      useFactory: (env: EnvService): JwtModuleOptions => {
        const accessSecret = env.get('JWT_ACCESS_SECRET');
        const refreshSecret = env.get('JWT_REFRESH_SECRET');
        if (!accessSecret || !refreshSecret) {
          throw new Error(
            'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required for the auth guard.',
          );
        }
        return { accessSecret, refreshSecret, issuer: env.get('BACKEND_HOST') };
      },
    }),
  ],
  // OrgModule is re-exported so AuthController can resolve OrgService for /auth/session.
  modules: [OrgModule],
  entities: [{ entity: User, repoClass: UserRepo }],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
