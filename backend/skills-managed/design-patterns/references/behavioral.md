# Behavioral patterns

Patterns for assigning responsibilities and orchestrating how objects collaborate. Diagnose the smell first (see SKILL.md); reach for one of these only when the boring refactor didn't remove it.

### Chain of Responsibility

**Intent.** Pass a request along a series of handlers until one handles it, without the sender knowing which one will.

**Use when.**
- You have a pipeline of independent checks/transforms (auth → rate-limit → validation → handler) that should be composable and reorderable.
- New steps get added over time and you don't want to edit one growing `if` chain to add them.

**Do NOT use when.**
- There are only 1-2 steps and their order never changes — a plain sequence of function calls is clearer.
- Every handler in the chain always runs (nothing is ever "skipped") — that's just a pipeline of functions, not a chain that short-circuits.

**TypeScript sketch.**
```ts
type Middleware = (req: Request, next: () => Promise<Response>) => Promise<Response>;

function compose(middlewares: Middleware[], handler: () => Promise<Response>): () => Promise<Response> {
  return middlewares.reduceRight<() => Promise<Response>>(
    (next, mw) => () => mw(currentRequest, next),
    handler,
  );
}

const pipeline = compose([authMiddleware, rateLimitMiddleware], () => routeHandler(currentRequest));
```

**Lighter alternative.** An array of functions reduced/composed in order (above) — this is exactly what Nest/Express middleware already gives you; don't build a custom `Handler` class hierarchy on top of a framework that already implements the chain for you.

### Command

**Intent.** Turn a request into a standalone object, so it can be queued, logged, undone, or passed around before it runs.

**Use when.**
- You need to queue, retry, undo, or audit-log operations as discrete units (job queues, undo/redo, transactional outbox).
- The invoker of an action shouldn't know the concrete operation it triggers.

**Do NOT use when.**
- You just need to call a function now — wrapping a direct call in a `Command` object with no queueing/undo need adds a layer that does nothing.
- There's no requirement to defer, log, or reverse the action.

**TypeScript sketch.**
```ts
type Command = { execute(): Promise<void>; undo?(): Promise<void> };

function createRefundCommand(orderId: string, cents: number): Command {
  return {
    execute: () => paymentsService.refund(orderId, cents),
    undo: () => paymentsService.chargeAgain(orderId, cents),
  };
}

await commandQueue.enqueue(createRefundCommand(order.id, 500));
```

**Lighter alternative.** A plain async function/closure captures "an action to run later" just as well when you don't need undo/serialization — reach for the `Command` object shape only when something downstream (a queue, an audit log, an undo stack) needs to hold the action as data.

### Iterator

**Intent.** Provide a uniform way to step through a collection's elements without exposing how the collection is stored.

**Use when.**
- You have a custom data structure (a tree, a paginated remote resource, a linked structure) and want consumers to `for...of` over it like an array.
- Traversal logic (e.g. cursor-based pagination) is duplicated at every call site.

**Do NOT use when.**
- You're iterating a plain `Array`/`Map`/`Set` — native iteration already covers it, don't wrap it.
- The traversal is one-off and used in exactly one place — inline the loop.

**TypeScript sketch.**
```ts
async function* paginate<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor);
}

for await (const user of paginate(fetchUserPage)) {
  process(user);
}
```

**Lighter alternative.** A generator function (above) is TypeScript's native Iterator — it gives you lazy, `for...of`-compatible traversal with no class, no `Symbol.iterator` boilerplate, and no separate `Iterator`/`Aggregate` types.

### Mediator

**Intent.** Centralize how a set of objects communicate, so they refer to the mediator instead of each other directly.

**Use when.**
- Several components need to coordinate (form fields validating against each other, widgets on a dashboard reacting to one another) and direct references between them are becoming a tangled many-to-many mesh.
- You want to change the interaction rules in one place instead of hunting through every participant.

**Do NOT use when.**
- Only two objects talk to each other — a direct call/callback is simpler than routing through a middleman.
- The "coordination" is really just one-directional notification — that's Observer, not Mediator.

**TypeScript sketch.**
```ts
type FormMediator = { onFieldChange(field: string, value: unknown): void };

class CheckoutFormMediator implements FormMediator {
  constructor(private readonly fields: Record<string, FormField>) {}

  onFieldChange(field: string, value: unknown): void {
    if (field === 'country') {
      this.fields.state.setOptions(statesFor(value as string));
      this.fields.taxId.setRequired(requiresTaxId(value as string));
    }
  }
}
```

**Lighter alternative.** A single orchestrating function/service that owns the shared state (above) beats routing every component through a formal `Mediator` interface — most "several things must coordinate" cases in a backend service are really just one service method with several dependencies.

### Memento

**Intent.** Capture and externally store an object's internal state so it can be restored later, without exposing that state's structure.

**Use when.**
- You need undo/rollback or point-in-time snapshots of a stateful object (an editor buffer, a multi-step wizard, a saga/transaction) without leaking its internals to the code that stores the snapshots.

**Do NOT use when.**
- Snapshotting is not undo/history — if you just need "the current value," that's plain state, not a Memento.
- The state is already a plain serializable object — `JSON.stringify`/spread it into a history array; you don't need a `Memento` class wrapper.

**TypeScript sketch.**
```ts
type WizardState = { step: number; answers: Record<string, unknown> };

class WizardHistory {
  private snapshots: WizardState[] = [];

  save(state: WizardState): void {
    this.snapshots.push(structuredClone(state));
  }

  undo(): WizardState | undefined {
    this.snapshots.pop();
    return this.snapshots.at(-1);
  }
}
```

**Lighter alternative.** An array of cloned plain-object snapshots (above) is a Memento with no ceremony — skip a dedicated `Memento` type unless the state has invariants that must be validated/encapsulated on restore.

### Observer

**Intent.** Let subscribers register interest in an object's events without that object knowing who's listening.

**Use when.**
- Multiple, independent parts of the system need to react to the same event (order placed → email, analytics, inventory update) and you don't want the emitter to call each one directly.
- Listeners are added/removed at runtime, or come from separate modules.

**Do NOT use when.**
- There's exactly one listener — call it directly; an event bus with one subscriber is indirection with no payoff.
- The "reaction" must happen synchronously and in a guaranteed order as part of one transaction — a direct function call is more honest than an event you hope fires in order.

**TypeScript sketch.**
```ts
type OrderPlacedListener = (order: Order) => void;

class OrderEvents {
  private listeners: OrderPlacedListener[] = [];

  onPlaced(listener: OrderPlacedListener): void {
    this.listeners.push(listener);
  }

  emitPlaced(order: Order): void {
    for (const listener of this.listeners) listener(order);
  }
}
```

**Lighter alternative.** Nest's built-in `EventEmitter2` (`@nestjs/event-emitter`) or a plain array of callbacks (above) — don't hand-roll a pub/sub bus when the framework already ships one, and don't reach for events at all if a direct call with 2-3 sequential steps reads just as clearly.

### State

**Intent.** Let an object change its behavior when its internal state changes, by delegating to a state-specific handler instead of branching on a status field everywhere.

**Use when.**
- The same `if (status === ...)`/`switch (status)` shows up in multiple methods across the codebase for one entity (an order, a subscription, a connection).
- Legal transitions between states are easy to get wrong and need to be enforced in one place.

**Do NOT use when.**
- The status only affects one `if` in one place — that single check doesn't need a state machine.
- States never transition (it's really just a fixed category, not a lifecycle) — that's an enum, not State.

**TypeScript sketch.**
```ts
type OrderState = 'pending' | 'paid' | 'shipped' | 'cancelled';

const transitions: Record<OrderState, OrderState[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: [],
  cancelled: [],
};

function transition(current: OrderState, next: OrderState): OrderState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Cannot move order from ${current} to ${next}`);
  }
  return next;
}
```

**Lighter alternative.** A transition table + union type (above) captures State's guarantee (only legal moves happen) without a class per state — reach for actual `State` objects/classes only when each state also carries distinct injected behavior/dependencies, not just a different set of legal next values.

### Strategy

**Intent.** Define a family of interchangeable behaviors and select one at runtime, without the caller knowing which.

**Use when.**
- Behavior varies by a type/kind and you're reaching for a `switch` on that kind in more than one place.
- The variants change independently of the code that invokes them.
- You want to unit-test each behavior in isolation.

**Do NOT use when.**
- There is exactly one behavior (a Strategy with one strategy is a smell — just write the code).
- The variation is a single expression → a lookup map or a function parameter is lighter.
- The branches never change → a plain `switch` is clearer than indirection.

**TypeScript sketch.**
```ts
type PricingStrategy = (cents: number) => number;

const strategies: Record<PlanTier, PricingStrategy> = {
  free: (c) => c,
  pro: (c) => Math.round(c * 0.9),
  enterprise: (c) => Math.round(c * 0.75),
};

const price = (tier: PlanTier, cents: number) => strategies[tier](cents);
```

**Lighter alternative.** In TypeScript a `Record<Kind, fn>` map (above) or a discriminated union + `switch` usually beats a class hierarchy of Strategy objects — reach for classes only when a strategy needs its own injected dependencies or lifecycle (e.g. a Nest provider).

### Template Method

**Intent.** Fix the skeleton of an algorithm in one place while letting each variant override specific steps.

**Use when.**
- Several variants share the same overall sequence of steps (validate → fetch → transform → save) and only 1-2 steps actually differ between them.
- You want to prevent variants from silently skipping or reordering shared steps.

**Do NOT use when.**
- The steps that vary are most of the algorithm, not a minority — you're not really sharing a skeleton, so just write separate functions.
- There's only one variant — there's no "template" yet, just an algorithm.

**TypeScript sketch.**
```ts
abstract class ImportJob<T> {
  async run(source: string): Promise<void> {
    const rows = await this.parse(source);
    const valid = rows.filter((r) => this.validate(r));
    await this.persist(valid);
  }

  protected abstract parse(source: string): Promise<T[]>;
  protected abstract validate(row: T): boolean;
  protected abstract persist(rows: T[]): Promise<void>;
}

class CsvUserImportJob extends ImportJob<UserRow> { /* implements the three steps */ }
```

**Lighter alternative.** A single higher-order function that takes the varying steps as parameters (`runImport({ parse, validate, persist })`) often beats an abstract class in TypeScript — no inheritance, same fixed skeleton, and it composes better with DI.

### Visitor

**Intent.** Add a new operation over a fixed set of types without modifying those types, by moving the operation into a separate "visitor" dispatched by type.

**Use when.**
- You have a stable, closed set of node types (an AST, a document's element types) and keep adding new *operations* over them (print, validate, serialize) rather than new node types.
- Scattering each new operation as a method on every type would bloat every type file for an unrelated concern.

**Do NOT use when.**
- The type set changes more often than the operations do — Visitor inverts the pain in that direction; plain methods per type age better here.
- There's only one operation, or the switch/map handling it lives in one place already — a `switch` over a discriminated union is simpler than a Visitor's double-dispatch machinery.

**TypeScript sketch.**
```ts
type Node = { kind: 'text'; value: string } | { kind: 'bold'; children: Node[] } | { kind: 'link'; href: string; children: Node[] };

function toHtml(node: Node): string {
  switch (node.kind) {
    case 'text': return escapeHtml(node.value);
    case 'bold': return `<b>${node.children.map(toHtml).join('')}</b>`;
    case 'link': return `<a href="${node.href}">${node.children.map(toHtml).join('')}</a>`;
  }
}
```

**Lighter alternative.** A discriminated union + exhaustive `switch` (above) gives TypeScript compile-time completeness checking and reads far more directly than classic double-dispatch Visitor classes — reach for real Visitor objects only in a language/setup without union exhaustiveness checking, or when the operation itself needs injected dependencies/state across the traversal.
