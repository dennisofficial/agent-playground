export type SeenTooling = {
  key: string;
  kind: 'repo-manifest' | 'env-binary';
  firstSeenAt: string;
};
