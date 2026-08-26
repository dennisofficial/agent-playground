const DATED_RELEASE = /-\d{8}$/

/**
 * Anthropic and OpenAI both stamp a release date onto the end of a model id. The footer has one
 * line to spend, and the sidebar still carries the id in full.
 */
export function modelLabel(modelId: string): string {
  return modelId.replace(DATED_RELEASE, '')
}
