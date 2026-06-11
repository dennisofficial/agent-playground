import { IsNotEmpty, IsString } from 'class-validator';

export class PutLlmKeyDto {
  /** WRITE-ONLY: accepted here, encrypted at rest, never returned by any endpoint. */
  @IsString()
  @IsNotEmpty()
  key!: string;
}
