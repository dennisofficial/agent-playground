// Control-plane entities (the gateway's `agent_control` database). Deliberately a SEPARATE list
// from ENTITIES: tenant stacks must never carry control-plane tables, and the control DB carries
// none of the harness schema.
export * from './tenant.entity';

import { Tenant } from './tenant.entity';

/** Pass to the gateway's TypeORM DataSource — never merge into ENTITIES. */
export const CONTROL_ENTITIES = [Tenant];
