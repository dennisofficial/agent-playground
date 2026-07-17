/**
 * Atlas v2 HTTP test-bridge — public barrel. A dev/test-only `POST /test/*` edge (auto-enabled
 * whenever NODE_ENV !== 'production'; hard-disabled in prod) for driving a real conversation with a
 * running Atlas. Zero v1 imports.
 */
export * from './test-bridge.controller';
export * from './test-bridge.dto';
export * from './test-bridge.module';
