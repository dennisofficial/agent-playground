export const WORK_MOUNT = '/workspace';
export const WORK_VOLUME = 'work';

export const ATLAS_STATE_MOUNT = '/atlas';
export const ATLAS_STATE_VOLUME = 'atlas-state';

export const DOCKER_STORAGE_MOUNT = '/var/lib/docker';
export const DOCKER_STORAGE_VOLUME = 'docker-storage';

// Swappable engine bundle (SANDBOX_ENGINE_HOTSWAP): sibling of the baked bundle so it never shadows the colocated
// SDK node_modules. atlas-engine-turn prefers ENGINE_MOUNT/engine-app.js when present.
export const ENGINE_MOUNT = '/usr/local/lib/atlas/engine';
export const ENGINE_VOLUME = 'engine';
