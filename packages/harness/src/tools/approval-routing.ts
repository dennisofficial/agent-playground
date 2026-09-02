export enum EApprovalRouting {
  Operator = 'operator',
  None = 'none',
}

export const unattendedReason = ({ reason }: { reason: string }): string =>
  `${reason} No operator is attached to this agent, so nobody here can authorise it: carry on with the rest of your task and say in your report what you wanted to do, what stopped it, and what you would need in order to proceed.`
