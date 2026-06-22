/** TanStack Query key factory for the `/web/*` data layer. Pure — safe to import from anywhere. */
export const qk = {
  channels: () => ['channels'] as const,
  channelMessages: (channel: string) => ['channel-messages', channel] as const,
  currentUser: () => ['current-user'] as const,
};
