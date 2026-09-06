export async function consumeImagePull(args: { response: Response; image: string }): Promise<void> {
  const output = await args.response.text()
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const progress: unknown = JSON.parse(line)
    if (typeof progress !== 'object' || progress === null) {
      throw new Error(`Pulling ${args.image} failed: the daemon answered out of shape`)
    }
    if ('error' in progress && typeof progress.error === 'string') {
      throw new Error(`Pulling ${args.image} failed: ${progress.error}`)
    }
    if (
      'errorDetail' in progress &&
      typeof progress.errorDetail === 'object' &&
      progress.errorDetail !== null &&
      'message' in progress.errorDetail &&
      typeof progress.errorDetail.message === 'string'
    ) {
      throw new Error(`Pulling ${args.image} failed: ${progress.errorDetail.message}`)
    }
  }
}
