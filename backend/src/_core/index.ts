// `_core` is plain shared backend source (NOT a built nest library). Each app's
// per-app tsconfig.json `include`s ../_core/**/*, so it compiles into the app and
// Nest CLI rewrites the @core/* alias to relative requires in the emitted JS.
export * from './setup-logger';
export * from './config/env/env.service';
export * from './config/env/validation';
