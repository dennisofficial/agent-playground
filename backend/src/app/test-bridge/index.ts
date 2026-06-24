/**
 * Atlas v2 HTTP test-bridge — public barrel. A dev/test-only `POST /test/*` edge (gated by
 * `TEST_BRIDGE=on`) for driving a real conversation with a running Atlas. Zero v1 imports.
 */
export * from './test-bridge.module';
export * from './test-bridge.controller';
export * from './test-bridge.dto';
