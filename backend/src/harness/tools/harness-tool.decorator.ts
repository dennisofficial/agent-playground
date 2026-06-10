import { Injectable } from '@nestjs/common';

export const HARNESS_TOOL_METADATA = Symbol('HARNESS_TOOL');

/**
 * Marks an injectable class as a chat-layer tool (must implement `IHarnessTool`). Discovered by
 * `ToolRegistry`; the class itself is the injection token employees use in their `tools` allowlist.
 * The class must also be listed in `ToolsModule.providers` (plain class provider — discovery can't
 * see factory providers).
 */
export const HarnessTool = (): ClassDecorator => (target) => {
  Injectable()(target);
  Reflect.defineMetadata(HARNESS_TOOL_METADATA, true, target);
};
