import { EnvService } from '@core/config/env/env.service';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule, type JwtModuleOptions } from '@workspace/auth/server';
import { DB_CONNECTION } from '../persistence/database.module';
import { UserEntity } from '../persistence/entities';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.forRootAsync({
      isGlobal: true,
      inject: [EnvService],
      useFactory: (env: EnvService): JwtModuleOptions => {
        const accessSecret = env.get('JWT_ACCESS_SECRET');
        const refreshSecret = env.get('JWT_REFRESH_SECRET');
        if (!accessSecret || !refreshSecret) {
          throw new Error(
            'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required for the Atlas web console auth guard.',
          );
        }
        return { accessSecret, refreshSecret, issuer: env.get('BACKEND_HOST') };
      },
    }),
    TypeOrmModule.forFeature([UserEntity], DB_CONNECTION),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
