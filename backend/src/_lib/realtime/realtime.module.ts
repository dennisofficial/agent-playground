import { EnvService } from '@core/config/env/env.service';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import {
  type EngineConfig,
  type ModelConfig,
  PgAdvisoryLockLeaderElector,
  PgNotifyBus,
} from '@workspace/pg-realtime';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { REALTIME_MODEL } from './realtime.tokens';

const RT_SLOT_NAME = 'pg_realtime_slot';
const RT_PUBLICATION_NAME = 'pg_realtime_pub';
const RT_LOCK_NAME = 'atlas_pg_realtime_leader';

function buildConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const password = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const appName = encodeURIComponent('atlas (pg-realtime)');
  return `postgresql://${user}:${password}@${env.get('POSTGRES_HOST')}:${env.get('POSTGRES_PORT')}/${env.get('POSTGRES_DB')}?application_name=${appName}`;
}

@Module({})
export class RealtimeModule {
  static forRoot(featureModules: Type[]): DynamicModule {
    return {
      module: RealtimeModule,
      imports: [
        PgRealtimeModule.forRootAsync({
          imports: featureModules,
          inject: [EnvService, REALTIME_MODEL],
          useFactory: (env: EnvService, contributed: ModelConfig[][]): EngineConfig => {
            const connectionString = buildConnectionString(env);
            return {
              connectionString,
              slotName: RT_SLOT_NAME,
              publicationName: RT_PUBLICATION_NAME,
              consume: true,
              leader: new PgAdvisoryLockLeaderElector({ connectionString, lockName: RT_LOCK_NAME }),
              bus: new PgNotifyBus({ connectionString }),
              models: contributed.flat(),
            };
          },
        }),
      ],
    };
  }
}
