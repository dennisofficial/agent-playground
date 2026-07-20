import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { type EJitTrigger, JIT_HOOK_METADATA, type JitHookMeta } from '@shared/jit/jit.decorator';

export interface RegisteredJitHook {
  meta: JitHookMeta;
  /** Invoke the hook's method with its owning instance bound. Args/return are engine-defined (later). */
  invoke: (...args: unknown[]) => unknown;
}

/**
 * Discovers every `@JitHook`-annotated provider method across the whole app at boot and indexes them by
 * trigger. This is the inversion that keeps feature modules from depending on `JitModule`: features attach
 * metadata (via the dependency-free `_lib/jit/contracts`), and this registry finds them through Nest's
 * `DiscoveryService`. Dispatch/matching behavior is NOT here yet — this pass only proves discovery works.
 */
@Injectable()
export class JitHostRegistry implements OnModuleInit {
  private readonly logger = new Logger(JitHostRegistry.name);
  private readonly hooks: RegisteredJitHook[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = (instance as Record<string, unknown>)[methodName];
        if (typeof method !== 'function') continue;
        const meta = this.reflector.get<JitHookMeta | undefined>(JIT_HOOK_METADATA, method);
        if (!meta) continue;
        this.hooks.push({
          meta,
          invoke: (...args: unknown[]) =>
            (method as (...a: unknown[]) => unknown).apply(instance, args),
        });
      }
    }
    this.logger.log(
      `Discovered ${this.hooks.length} JIT hook(s): ${this.hooks.map((h) => h.meta.id).join(', ') || '—'}`,
    );
  }

  /** Hooks registered for a given trigger kind. */
  hooksFor(trigger: EJitTrigger): RegisteredJitHook[] {
    return this.hooks.filter((h) => h.meta.trigger === trigger);
  }

  /** All discovered hooks. */
  all(): readonly RegisteredJitHook[] {
    return this.hooks;
  }
}
