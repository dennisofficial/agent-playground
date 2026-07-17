import { AUTO_APPROVE_MODES, type AutoApproveMode } from '@workspace/shared';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  slug?: string;

  @IsOptional()
  @IsIn(AUTO_APPROVE_MODES)
  defaultAutoApproveMode?: AutoApproveMode;

  @IsOptional()
  @IsBoolean()
  defaultAutoMerge?: boolean;
}
