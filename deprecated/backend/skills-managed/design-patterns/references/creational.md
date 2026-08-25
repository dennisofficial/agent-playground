# Creational patterns

Patterns for constructing objects so the caller doesn't need to know the concrete class or the construction steps. Diagnose the smell first (see SKILL.md); reach for one of these only when the boring refactor didn't remove it.

### Factory Method

**Intent.** Let a subclass/config decide which concrete class to instantiate, behind one creation call.

**Use when.**

- A constructor call is duplicated across call sites and picks a class based on a runtime value.
- You want callers to depend on a return type, not a concrete constructor.
- New variants get added over time and you don't want call sites touched each time.

**Do NOT use when.**

- There is only one concrete class to make — a factory around one implementation is ceremony.
- A plain function returning a literal/object already does the job.

**TypeScript sketch.**

```ts
type NotificationChannel = 'email' | 'sms' | 'push';

type Notifier = { send(userId: string, body: string): Promise<void> };

function createNotifier(channel: NotificationChannel): Notifier {
  switch (channel) {
    case 'email':
      return new EmailNotifier();
    case 'sms':
      return new SmsNotifier();
    case 'push':
      return new PushNotifier();
  }
}
```

**Lighter alternative.** A `Record<Kind, () => T>` map or a plain constructor call at the one call site that needs it; only extract a factory once a second call site needs the same decision.

### Abstract Factory

**Intent.** Produce a family of related objects that must stay consistent with each other, without the caller naming concrete classes.

**Use when.**

- Objects are created in matched sets (e.g. a UI theme's button + input + modal, or a provider's client + logger + retry policy) and mixing sets breaks things.
- You swap the whole family at a boundary (per-tenant config, per-environment SDK client).

**Do NOT use when.**

- You only ever need one member of the "family" at a time — that's plain Factory Method, not this.
- The family has one implementation today — wait until a second one actually exists.

**TypeScript sketch.**

```ts
type PaymentProviderKit = {
  client: PaymentClient;
  webhookVerifier: WebhookVerifier;
};

const kits: Record<'stripe' | 'braintree', () => PaymentProviderKit> = {
  stripe: () => ({ client: new StripeClient(), webhookVerifier: new StripeWebhookVerifier() }),
  braintree: () => ({
    client: new BraintreeClient(),
    webhookVerifier: new BraintreeWebhookVerifier(),
  }),
};

const kit = kits[provider]();
```

**Lighter alternative.** A config object of grouped constructors (above) or a NestJS dynamic module that binds the right provider set per environment — skip a class hierarchy until the families genuinely diverge in behavior, not just in constructor args.

### Builder

**Intent.** Assemble a complex object through a sequence of small steps instead of one overloaded constructor.

**Use when.**

- A constructor/function has many optional parameters and callers only ever set a few.
- Construction has an order dependency or validation that spans steps (e.g. a query builder, an HTTP request spec).

**Do NOT use when.**

- The object has 2-3 fields — a plain object literal or parameter object is lighter.
- All fields are required and independent — there's nothing "optional" or "staged" to build.

**TypeScript sketch.**

```ts
class QueryBuilder<T> {
  private filters: Partial<T> = {};
  private limitVal?: number;

  where(filters: Partial<T>): this {
    this.filters = { ...this.filters, ...filters };
    return this;
  }
  limit(n: number): this {
    this.limitVal = n;
    return this;
  }
  build(): { filters: Partial<T>; limit?: number } {
    return { filters: this.filters, limit: this.limitVal };
  }
}

const query = new QueryBuilder<User>().where({ active: true }).limit(20).build();
```

**Lighter alternative.** A parameter object with optional fields (`function createUser(opts: { name: string; email?: string; role?: Role })`) beats a Builder whenever there's no staged/order-dependent construction — reach for Builder only when steps compose or validate against each other.

### Prototype

**Intent.** Create a new object by cloning an existing instance instead of building one from scratch.

**Use when.**

- Constructing from raw inputs is expensive (parsing, a DB round-trip, a computed default set) but copying an in-memory instance is cheap.
- You need many variants of a base configuration that differ by a few overridden fields.

**Do NOT use when.**

- The object is a plain data shape — `{ ...base, overrides }` already is Prototype; you don't need a `clone()` method or class for it.
- Deep-clone semantics are actually needed only once — inline `structuredClone`/spread there instead of building an abstraction.

**TypeScript sketch.**

```ts
type RequestDefaults = { timeoutMs: number; retries: number; headers: Record<string, string> };

const baseDefaults: RequestDefaults = {
  timeoutMs: 5000,
  retries: 2,
  headers: { Accept: 'application/json' },
};

function withOverrides(
  base: RequestDefaults,
  overrides: Partial<RequestDefaults>,
): RequestDefaults {
  return { ...base, ...overrides, headers: { ...base.headers, ...overrides.headers } };
}

const uploadDefaults = withOverrides(baseDefaults, { timeoutMs: 30_000 });
```

**Lighter alternative.** Object spread / `structuredClone` (above) covers nearly every real case in TypeScript — a `Prototype` class with a `clone()` method only earns its keep when cloning needs custom logic beyond a shallow/deep copy (e.g. re-establishing a DB connection on the clone).

### Singleton

**Intent.** Guarantee a single shared instance of something, reachable from anywhere.

**Use when.**

- You truly need one physical resource shared process-wide with no per-request variation (e.g. a metrics registry, a process-level feature-flag cache) and it isn't already handled by your DI container.

**Do NOT use when.**

- You're in Nest/DI-land: a Nest provider (default singleton scope) or a module-scoped service already gives you this — a hand-rolled `getInstance()` with global mutable state fights the container, breaks test isolation (can't swap a mock), and hides the dependency from constructors.
- You just want "one instance per request/tenant" — that's request scope, not Singleton.
- A plain module-level `const` (ES modules are already singletons) is enough and doesn't need a class wrapper at all.

**TypeScript sketch.**

```ts
// Prefer: let the DI container own the lifetime.
@Injectable()
export class MetricsRegistry {
  private counters = new Map<string, number>();
  increment(name: string): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
}

// Nest wires this as one shared instance per process by default —
// no getInstance(), no static state, and it's mockable in tests.
```

**Lighter alternative.** DI (a `@Injectable()` provider, above) or a module-scoped `const` for stateless/config values — reach for a hand-rolled Singleton only outside a DI-managed process (a CLI script, a Lambda cold-start cache) where no container exists to hold the instance for you.
