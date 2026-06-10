import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class PutTokenDto {
  @Matches(/^[a-z0-9][a-z0-9._-]*$/, {
    message: 'name must be lowercase alphanumeric (dot/dash/underscore allowed)',
  })
  name!: string;

  /** WRITE-ONLY: accepted here, encrypted at rest, never returned by any endpoint. */
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsOptional()
  @IsBoolean()
  default?: boolean;
}
