export const LABEL_ORG = 'atlas.io/org';
export const LABEL_JOB = 'atlas.io/job';
export const POD_NAME_PREFIX = 'sbx-';

export const MAIN_CONTAINER = 'main';
export const SETUP_CONTAINER = 'setup';

export const ENGINE_ENTRYPOINT = '/usr/local/lib/atlas/atlas-engine-turn';
export const SHELL_PREFIX_WRAPPER = '/usr/local/bin/atlas-classify';

export const POD_RESOURCES = {
  requests: { cpu: '25m', memory: '64Mi' },
  limits: { cpu: '2', memory: '4Gi' },
};

export const LEASE_TTL_S = 30 * 60;
