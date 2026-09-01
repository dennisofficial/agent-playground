export enum EJudgment {
  Proceed = 'proceed',
  Check = 'check',
}

export type Verdict = { judgment: EJudgment; reason: string }
