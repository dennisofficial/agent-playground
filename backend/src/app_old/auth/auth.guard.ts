import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { BaseAuthGuard, JwtService } from '@workspace/auth/server';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { UserEntity } from '../persistence/entities';

@Injectable()
export class AuthGuard extends BaseAuthGuard {
  constructor(
    reflector: Reflector,
    jwtService: JwtService,
    @InjectRepository(UserEntity, DB_CONNECTION)
    private readonly users: Repository<UserEntity>,
  ) {
    super(reflector, jwtService);
  }

  async findUser(sub: string): Promise<UserEntity | null> {
    return this.users.findOne({ where: { id: sub } });
  }
}
