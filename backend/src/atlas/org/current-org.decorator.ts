import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** The resolved org context attached by `OrgMembershipGuard`. */
export interface CurrentOrgCtx {
  id: string;
  role: string;
}

/**
 * Injects the org context the `OrgMembershipGuard` attached to the request (`{ id, role }`). Only valid
 * on routes guarded by `OrgMembershipGuard` (i.e. `/web/orgs/:orgId/*`).
 */
export const CurrentOrg = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentOrgCtx => {
    return ctx.switchToHttp().getRequest().org;
  },
);
