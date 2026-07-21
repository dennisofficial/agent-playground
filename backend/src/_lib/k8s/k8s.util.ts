export function isK8sNotFoundError(err: unknown): boolean {
  return isK8sStatusCode(err, 404);
}

export function isK8sConflictError(err: unknown): boolean {
  return isK8sStatusCode(err, 409);
}

function isK8sStatusCode(err: unknown, code: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === code
  );
}
