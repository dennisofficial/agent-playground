import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AdminUser } from '@workspace/shared/schemas';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

/**
 * Thin data-access layer for AdminUser.  All queries live here; nothing else
 * touches the TypeORM repository directly.
 */
@Injectable()
export class AdminUserStore {
  constructor(
    @InjectRepository(AdminUser)
    private readonly repo: Repository<AdminUser>,
  ) {}

  findByEmail(email: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { email } });
  }

  findById(id: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(data: {
    email: string;
    password_hash: string;
    name?: string | null;
    role?: string;
  }): Promise<AdminUser> {
    const user = this.repo.create({
      id: randomUUID(),
      email: data.email,
      password_hash: data.password_hash,
      name: data.name ?? null,
      role: data.role ?? 'admin',
    });
    return this.repo.save(user);
  }
}
