import { AdminUser } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';

/** Typed DI alias for the AdminUser TypeORM repository (cubix-infra style). */
export class AdminUserRepo extends Repository<AdminUser> {}
