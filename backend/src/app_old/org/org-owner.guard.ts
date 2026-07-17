import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

@Injectable()
export class OrgOwnerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ org?: { id: string; role: string } }>();
    if (req.org?.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can perform this action');
    }
    return true;
  }
}
