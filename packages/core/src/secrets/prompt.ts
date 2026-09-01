export type SecretPrompt = {
  name: string
  label: string
  masked: boolean
  typed: string
}

export enum ESecretCommit {
  Save = 'save',
  Clear = 'clear',
}

export type SecretCommit =
  | { action: ESecretCommit.Save; name: string; value: string }
  | { action: ESecretCommit.Clear; name: string }

export const openSecretPrompt = (args: {
  name: string
  label: string
  masked: boolean
}): SecretPrompt => ({ ...args, typed: '' })

export const typeIntoSecretPrompt = (args: {
  prompt: SecretPrompt
  text: string
}): SecretPrompt => ({ ...args.prompt, typed: `${args.prompt.typed}${args.text}` })

export const backspaceSecretPrompt = (prompt: SecretPrompt): SecretPrompt => ({
  ...prompt,
  typed: [...prompt.typed].slice(0, -1).join(''),
})

export function commitSecretPrompt(prompt: SecretPrompt): SecretCommit {
  const value = prompt.typed.trim()
  if (value.length === 0) return { action: ESecretCommit.Clear, name: prompt.name }
  return { action: ESecretCommit.Save, name: prompt.name, value }
}
