export enum EExecutionLocation {
  Host = 'host',
  Docker = 'docker',
}

export function executionLocationOf(
  value: string | null | undefined,
): EExecutionLocation | undefined {
  if (value === EExecutionLocation.Host) return EExecutionLocation.Host
  if (value === EExecutionLocation.Docker) return EExecutionLocation.Docker
  return undefined
}
