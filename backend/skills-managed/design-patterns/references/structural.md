# Structural patterns

Patterns for composing objects and classes into larger shapes without their internals getting tangled up. Diagnose the smell first (see SKILL.md); reach for one of these only when the boring refactor didn't remove it.

### Adapter

**Intent.** Convert one interface into another so incompatible code can work together.

**Use when.**

- A third-party SDK or legacy module's shape doesn't match what the rest of your code expects.
- You're migrating from one library to another and want callers unaffected during the transition.

**Do NOT use when.**

- You own both sides — just change one of the interfaces to match instead of adapting forever.
- The "adaptation" is a single field rename — a one-line map at the call site beats a class.

**TypeScript sketch.**

```ts
type Logger = { info(msg: string, meta?: Record<string, unknown>): void };

// Third-party client only exposes .log(level, message, data)
function adaptVendorLogger(vendor: VendorLogger): Logger {
  return {
    info: (msg, meta) => vendor.log('info', msg, meta ?? {}),
  };
}
```

**Lighter alternative.** An inline wrapper function at the boundary (above) — skip a class and a formal `Adapter` type until you have multiple methods to bridge or multiple vendors implementing the same target shape.

### Bridge

**Intent.** Split an abstraction from its implementation so each can vary independently.

**Use when.**

- You have two dimensions that multiply (e.g. notification _type_ × delivery _channel_) and subclassing every combination is exploding.
- You need to swap an implementation (a storage backend, a rendering engine) without touching the higher-level logic that uses it.

**Do NOT use when.**

- There's only one implementation in practice — you're building a seam nobody crosses yet.
- One of the two "dimensions" is really just a parameter — pass it as an argument instead of splitting into two class hierarchies.

**TypeScript sketch.**

```ts
type FileStore = { save(path: string, data: Buffer): Promise<void> };

class ReportGenerator {
  constructor(private readonly store: FileStore) {} // abstraction depends on an interface, not a concrete store

  async generate(name: string, rows: Row[]): Promise<void> {
    const csv = toCsv(rows);
    await this.store.save(`${name}.csv`, Buffer.from(csv));
  }
}

const generator = new ReportGenerator(
  process.env.NODE_ENV === 'test' ? new MemoryStore() : new S3Store(),
);
```

**Lighter alternative.** Constructor injection of a plain interface (above, and idiomatic in Nest anyway) — that already _is_ Bridge. Don't add a separate parallel class hierarchy on top; the DI seam is the pattern.

### Composite

**Intent.** Treat an individual object and a group of objects through the same interface, so client code doesn't special-case "is this one thing or many."

**Use when.**

- You have a part/whole tree (folders and files, a nested rule/condition tree, a menu with submenus) and callers keep writing `if (isGroup) { recurse } else { handle leaf }`.
- Operations (validate, render, total up) need to apply uniformly at every level of the tree.

**Do NOT use when.**

- The structure is only ever one level deep — there's no real "whole made of parts" recursion to unify.
- A flat array with a `parentId` and a couple of reduce/filter calls already answers every query you need.

**TypeScript sketch.**

```ts
type Condition =
  | { kind: 'leaf'; field: string; op: '=' | '>'; value: unknown }
  | { kind: 'and' | 'or'; children: Condition[] };

function evaluate(cond: Condition, row: Record<string, unknown>): boolean {
  if (cond.kind === 'leaf') return applyOp(cond.op, row[cond.field], cond.value);
  const results = cond.children.map((c) => evaluate(c, row));
  return cond.kind === 'and' ? results.every(Boolean) : results.some(Boolean);
}
```

**Lighter alternative.** A discriminated union + recursive function (above) gets you Composite's uniform-treatment benefit without a class hierarchy — reach for actual `Leaf`/`Composite` classes only when each node needs distinct injected behavior beyond data + recursion.

### Decorator

**Intent.** Attach behavior to an object at runtime by wrapping it, without touching its class or its other wrappers.

**Use when.**

- You need to layer cross-cutting behavior (logging, caching, retry, auth check) around a call and want layers combinable independently.
- Subclassing for every combination of add-ons would multiply classes.

**Do NOT use when.**

- Only one behavior ever wraps the base — just inline it in the function.
- The "layers" always apply together in the same fixed order — merge them into one function instead of pretending they're independent.

**TypeScript sketch.**

```ts
type Fetcher = (url: string) => Promise<Response>;

function withRetry(fetcher: Fetcher, retries = 2): Fetcher {
  return async (url) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetcher(url);
      } catch (err) {
        if (attempt >= retries) throw err;
      }
    }
  };
}

const resilientFetch = withRetry(withCache(fetch));
```

**Lighter alternative.** A higher-order function that wraps another function (above) — this is Decorator with zero class ceremony. Reach for wrapper _classes_ only when the thing being decorated has multiple methods that all need wrapping together (e.g. a repository interface).

### Facade

**Intent.** Offer one simple entry point over a set of subsystems, hiding their internal wiring.

**Use when.**

- Callers routinely orchestrate the same 3+ subsystems in the same order (e.g. validate → charge → send receipt) and that sequence is duplicated.
- You want to decouple calling code from a subsystem's internal shape so it can change without ripple.

**Do NOT use when.**

- There's only one subsystem to call — that's not a facade, that's just calling it.
- The facade would just forward every call 1:1 with no simplification — it's a middle-man layer, delete it.

**TypeScript sketch.**

```ts
@Injectable()
export class CheckoutFacade {
  constructor(
    private readonly pricing: PricingService,
    private readonly payments: PaymentService,
    private readonly receipts: ReceiptService,
  ) {}

  async checkout(cart: Cart): Promise<Receipt> {
    const total = this.pricing.total(cart);
    await this.payments.charge(cart.customerId, total);
    return this.receipts.send(cart.customerId, total);
  }
}
```

**Lighter alternative.** A plain orchestrating function/service method (above is already about as light as a Facade gets) — don't add a further "manager" or "orchestrator" layer on top of the facade itself.

### Flyweight

**Intent.** Share a single instance of expensive, immutable data across many logical objects instead of duplicating it per instance.

**Use when.**

- You're instantiating a very large number of objects that share most of their state (e.g. per-cell grid formatting, glyph/icon metadata, i18n locale bundles) and memory is measurably a problem.
- The shared part is genuinely immutable and identical across users.

**Do NOT use when.**

- Object counts are small (hundreds, not millions) — this is a memory-pressure fix, and premature use just adds an indirection layer for no measured win.
- The "shared" data actually varies per instance — you'd be forcing state that isn't common into a shared bucket.

**TypeScript sketch.**

```ts
type IconStyle = { svgPath: string; viewBox: string }; // heavy, shared

const styleCache = new Map<string, IconStyle>();

function getIconStyle(name: string): IconStyle {
  const cached = styleCache.get(name);
  if (cached) return cached;
  const style = loadIconStyle(name); // expensive parse, done once
  styleCache.set(name, style);
  return style;
}

type IconInstance = { style: IconStyle; x: number; y: number }; // only the extrinsic part varies
```

**Lighter alternative.** A plain `Map`-based cache (above) is Flyweight in practice — measure first (profiler/memory snapshot) before reaching for this; most services never hit the object count where it matters.

### Proxy

**Intent.** Stand in for another object to control access to it — lazy load, cache, guard, or log around it — while keeping the same interface.

**Use when.**

- You need to add access control, caching, or lazy initialization in front of a real object, transparently to callers.
- The real object is expensive to create and might not be needed on every path.

**Do NOT use when.**

- You can add the check/cache directly in the real object or the caller — a Proxy is worth it only when callers must not know the difference and multiple callers share the wrapped access.
- It's a one-off `if (!cache.has(key))` — inline that instead of standing up a Proxy type.

**TypeScript sketch.**

```ts
type ConfigStore = { get(key: string): Promise<string | undefined> };

function withReadCache(store: ConfigStore): ConfigStore {
  const cache = new Map<string, string | undefined>();
  return {
    get: async (key) => {
      if (cache.has(key)) return cache.get(key);
      const value = await store.get(key);
      cache.set(key, value);
      return value;
    },
  };
}

const cachedConfig = withReadCache(remoteConfigStore);
```

**Lighter alternative.** This is functionally identical to Decorator when the goal is caching/logging (above); use the term "Proxy" specifically when the intent is _access control_ (auth, lazy init) rather than adding behavior — otherwise just call it a wrapper and move on.
