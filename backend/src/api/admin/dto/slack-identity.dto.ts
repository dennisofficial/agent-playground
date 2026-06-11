import { Matches } from 'class-validator';

export class PutSlackIdentityDto {
  /** WRITE-ONLY: accepted here, encrypted at rest, never returned by any endpoint. */
  @Matches(/^xoxb-\S+$/, {
    message:
      'token must be a bot token (xoxb-…) from the employee’s puppet app',
  })
  token!: string;
}
