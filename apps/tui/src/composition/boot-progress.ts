export enum EBootStep {
  Composing = 'composing',
  Authorising = 'authorising',
  Highlighting = 'highlighting',
  Opening = 'opening',
  Ready = 'ready',
}

const LABELS: Readonly<Record<EBootStep, string>> = {
  [EBootStep.Composing]: 'wiring the harness',
  [EBootStep.Authorising]: 'checking credentials',
  [EBootStep.Highlighting]: 'loading grammars',
  [EBootStep.Opening]: 'opening the conversation',
  [EBootStep.Ready]: 'ready',
}

export const bootStepLabel = (step: EBootStep): string => LABELS[step]

export type BootProgress = {
  step: () => EBootStep
  report: (step: EBootStep) => void
  subscribe: (listener: () => void) => () => void
}

export function createBootProgress(): BootProgress {
  const listeners = new Set<() => void>()
  let current = EBootStep.Composing

  return {
    step: () => current,
    report: (step) => {
      if (step === current) return
      current = step
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
