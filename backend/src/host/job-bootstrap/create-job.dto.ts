import { EJobKind } from '@workspace/shared';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateJobDto {
  @IsUUID()
  orgId!: string;

  @IsUUID()
  repoId!: string;

  @IsString()
  @IsNotEmpty()
  firstMessage!: string;

  @IsOptional()
  @IsString()
  title?: string;

  /** Restricted to the two operator-selectable kinds; `Auto`/`review` are out of S1 scope. */
  @IsOptional()
  @IsIn([EJobKind.FEATURE, EJobKind.BUGFIX])
  kind?: EJobKind;
}
