export enum EApprovalRouting {
  Operator = 'operator',
  None = 'none',
}

export const unattendedReason = ({ reason }: { reason: string }): string =>
  `${reason} Only the operator can approve that, and no operator is attached to this agent: report what you wanted to do and let the main thread propose it.`
