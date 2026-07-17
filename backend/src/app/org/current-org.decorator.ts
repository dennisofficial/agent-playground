import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface CurrentOrgCtx {
  id: string;
  role: string;
}

export const CurrentOrg = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CurrentOrgCtx => {
    return ctx.switchToHttp().getRequest().org;
  },
);
