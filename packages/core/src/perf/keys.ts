export enum EPerfCounter {
  TranscriptRepublish = 'transcriptRepublish',
  RepublishMs = 'republishMs',
  ChannelChunk = 'channelChunk',
  PollShellsMs = 'pollMs:shells',
  PollServicesMs = 'pollMs:services',
  TurnMs = 'turnMs',
  TurnLogReadMs = 'turnLogReadMs',
  TurnAssembleMs = 'turnAssembleMs',
  TurnModelStepMs = 'turnModelStepMs',
  TurnToolMs = 'turnToolMs',
  TurnAppendMs = 'turnAppendMs',
  HarnessChunk = 'harnessChunk',
  HarnessChunkMs = 'harnessChunkMs',
  PartWaitMs = 'partWaitMs',
}

export enum EPerfGauge {
  TurnDepth = 'turnDepth',
  HarnessTurnDepth = 'harnessTurnDepth',
  ModelStreamDepth = 'modelStreamDepth',
  ActiveShells = 'activeShells',
}

export enum EPerfModelRole {
  Titler = 'titler',
  Summariser = 'summariser',
  Tldr = 'tldr',
}

export type PerfModelKey =
  | `modelCall:${EPerfModelRole}`
  | `modelStream:${EPerfModelRole}`
  | `modelChunk:${EPerfModelRole}`

export type PerfCounterKey = EPerfCounter | PerfModelKey

export const modelCallKey = (role: EPerfModelRole): PerfModelKey => `modelCall:${role}`
export const modelStreamKey = (role: EPerfModelRole): PerfModelKey => `modelStream:${role}`
export const modelChunkKey = (role: EPerfModelRole): PerfModelKey => `modelChunk:${role}`
