/**
 * True when `err` is a Kubernetes API 404 (resource not found). Used by wrappers that want to
 * normalize 404 to `null` / no-op instead of surfacing an exception.
 */
export function isK8sNotFoundError(err: unknown): boolean {
  return isK8sStatusCode(err, 404);
}

/** True when `err` is a Kubernetes API 409 (conflict / already exists). Used so a racing pod create
 *  falls through to wait-for-Ready instead of surfacing an error. */
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
