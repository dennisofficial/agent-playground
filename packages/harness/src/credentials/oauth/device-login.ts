import type { OauthLogin } from './anthropic-oauth-client'

export enum EDevicePoll {
  Pending = 'pending',
  Complete = 'complete',
}

export type DeviceLogin = {
  deviceAuthId: string
  userCode: string
  verificationUrl: string
  intervalMs: number
  expiresInMs: number
}

export type DevicePoll =
  | { status: EDevicePoll.Pending }
  | { status: EDevicePoll.Complete; login: OauthLogin }

export interface DeviceLoginClient {
  startDeviceLogin(): Promise<DeviceLogin>
  pollDeviceLogin(args: { deviceAuthId: string; userCode: string }): Promise<DevicePoll>
}
