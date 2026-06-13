import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { Injectable, OnModuleInit, Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { captureParentChatTrace } from '@workspace/langfuse';
import { getIdentity } from '../domain/identity';
import { collectDecorated } from '../discovery.util';
import { HARNESS_TOOL_METADATA } from './harness-tool.decorator';
import type { IHarnessTool, RefreshScope } from './tool.types';

/**
 * Discovers every `@HarnessTool()` class provider and resolves employees' class-reference
 * allowlists into bound LangChain StructuredTools at graph-build time. Identity reaches each call
 * through LangChain's `config.configurable.identity` (set per turn by the conductor) — the same
 * mechanism the playground used, unchanged.
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private byClass = new Map<Type, IHarnessTool>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    const found = collectDecorated<IHarnessTool>(
      this.discovery,
      HARNESS_TOOL_METADATA,
    );
    this.byClass = new Map(
      found.map(({ instance, metatype }) => [metatype, instance]),
    );
    const names = new Set<string>();
    for (const impl of this.byClass.values()) {
      if (names.has(impl.name)) {
        throw new Error(
          `Duplicate @HarnessTool name '${impl.name}' — tool names must be unique`,
        );
      }
      names.add(impl.name);
    }
  }

  /** All discovered tool classes (the universe an allowlist may draw from). */
  classes(): Type[] {
    return [...this.byClass.keys()];
  }

  private resolve(cls: Type<IHarnessTool>): IHarnessTool {
    const impl = this.byClass.get(cls);
    if (!impl) {
      throw new Error(
        `Tool class ${cls.name} is not registered — add it to ToolsModule providers (as a plain class provider) and decorate it with @HarnessTool()`,
      );
    }
    return impl;
  }

  /** Resolve a class-reference allowlist into LangChain tools, ready for `model.bindTools`. */
  toStructuredTools(
    classes: ReadonlyArray<Type<IHarnessTool>>,
  ): StructuredToolInterface[] {
    return classes.map((cls) => {
      const impl = this.resolve(cls);
      return tool(
        async (
          args: unknown,
          config?: { configurable?: Record<string, unknown> },
        ) =>
          impl.execute(args as never, {
            identity: getIdentity(config),
            parentChatTrace: captureParentChatTrace(),
          }),
        { name: impl.name, description: impl.description, schema: impl.schema },
      );
    });
  }

  /** LLM-visible names of the allowlist's TERMINAL tools (calls that end the bot's turn). */
  terminalToolNames(classes: ReadonlyArray<Type<IHarnessTool>>): Set<string> {
    return new Set(
      classes
        .map((cls) => this.resolve(cls))
        .filter((impl) => impl.terminal)
        .map((impl) => impl.name),
    );
  }

  /**
   * Map from tool name → the context scopes it dirties, for the allowlist's context-refresh tools.
   * Only tools with a non-empty `refreshesContext` array appear in the map. Mirrors `terminalToolNames`.
   */
  refreshScopesByName(
    classes: ReadonlyArray<Type<IHarnessTool>>,
  ): Map<string, readonly RefreshScope[]> {
    const m = new Map<string, readonly RefreshScope[]>();
    for (const cls of classes) {
      const impl = this.resolve(cls);
      if (impl.refreshesContext?.length) m.set(impl.name, impl.refreshesContext);
    }
    return m;
  }
}
