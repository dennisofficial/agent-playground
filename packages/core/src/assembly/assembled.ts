import type { EventRef } from '../events/envelope'
import type { Message } from '../message/message'
import type { ProviderOptions } from '../provider'

export type SystemBlock = { text: string; providerOptions?: ProviderOptions | undefined }

export type AssembledMessage = { message: Message; origin: EventRef }

export type Assembled = {
  system: readonly SystemBlock[]
  messages: readonly AssembledMessage[]
}
