# Refactorings

Fowler's mechanical refactoring moves — the boring, behavior-preserving edits to try before naming a Gang-of-Four pattern (see the response ladder in SKILL.md, step 2). Most "I need a pattern" moments are actually one of these.

## Composing methods

### Extract Function

**Removes.** A function doing more than one thing, or a comment explaining what a block of code does.

**Mechanics.**

- Pick a cohesive chunk of the function body and give it a name that states its intent.
- Turn it into its own function, passing in whatever local variables it reads and returning whatever it produces.
- Replace the original chunk with a call to the new function.

**TS before → after.**

```ts
// before
function renderInvoice(order: Order): string {
  let total = 0;
  for (const line of order.lines) total += line.qty * line.unitPriceCents;
  const tax = Math.round(total * 0.0825);
  return `Total: ${(total + tax) / 100}`;
}
```

```ts
// after
function renderInvoice(order: Order): string {
  const total = sumLines(order.lines);
  return `Total: ${(total + taxFor(total)) / 100}`;
}

function sumLines(lines: OrderLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty * line.unitPriceCents, 0);
}

function taxFor(totalCents: number): number {
  return Math.round(totalCents * 0.0825);
}
```

**Enough on its own when.** The variation you were worried about is just "this logic has a name now" — if there's only ever one way to compute the extracted piece, stop here. Don't wrap it in a Strategy until a second, genuinely different implementation shows up.

### Extract Variable

**Removes.** A dense expression that needs a comment to explain what it means.

**Mechanics.**

- Name the sub-expression for what it represents, not how it's computed.
- Assign it to a local `const`.
- Replace the inline expression with the new variable.

**TS before → after.**

```ts
// before
if (order.total > 10_000 && order.customer.country !== 'US' && !order.customer.isVerified) {
  flagForReview(order);
}
```

```ts
// after
const isLargeOrder = order.total > 10_000;
const isUnverifiedForeignCustomer = order.customer.country !== 'US' && !order.customer.isVerified;
if (isLargeOrder && isUnverifiedForeignCustomer) {
  flagForReview(order);
}
```

**Enough on its own when.** The problem was readability, not structure. If naming the pieces makes the condition self-explanatory, there is no smell left to hand off to a pattern.

### Inline Function

**Removes.** An indirection layer whose body is as clear as its name — a wrapper that adds a hop without adding meaning.

**Mechanics.**

- Confirm the function body isn't overridden or mocked anywhere that would break.
- Replace every call site with the function's body.
- Delete the now-unused function.

**TS before → after.**

```ts
// before
function isEven(n: number): boolean {
  return n % 2 === 0;
}
if (isEven(page)) { ... }
```

```ts
// after
if (page % 2 === 0) { ... }
```

**Enough on its own when.** The function existed for a "someday" reason (an extension point nobody used) rather than a real caller today. Deleting the seam is the fix — don't replace it with a formal extension-point pattern until a second implementation actually exists.

### Inline Variable

**Removes.** A local variable that just repeats its own initializing expression and adds nothing to readability.

**Mechanics.**

- Confirm the expression has no side effects that depend on being evaluated exactly once.
- Replace every use of the variable with its initializing expression.
- Delete the declaration.

**TS before → after.**

```ts
// before
const isActive = user.status === 'active';
return isActive;
```

```ts
// after
return user.status === 'active';
```

**Enough on its own when.** The variable was pure naming ceremony, not shared computation. If it's read more than once or the expression is expensive, keep it — that's a reason to extract, not inline.

### Rename (Function/Variable/Field)

**Removes.** A name that no longer says what the thing does, forcing readers to open the implementation to find out.

**Mechanics.**

- Pick a name that states the current intent, not the history of how it got there.
- Use the language server's rename (not find-and-replace) so every reference, including across files, updates together.
- Re-check call sites read naturally with the new name in place.

**TS before → after.**

```ts
// before
function proc(d: OrderData): number { ... }
```

```ts
// after
function calculateShippingCents(order: OrderData): number { ... }
```

**Enough on its own when.** The code's behavior was already right and only its name was lying. Renaming is never a reason to introduce a pattern — if you notice yourself renaming the same concept in three unrelated places, that's a duplication smell to fix separately, not a naming problem.

## Simplifying conditionals

### Decompose Conditional

**Removes.** A branch (condition + consequent + alternative) so packed with logic that the reader can't see what the branch is actually deciding.

**Mechanics.**

- Extract the condition itself into a well-named function.
- Extract the "then" branch into a well-named function.
- Extract the "else" branch into a well-named function.

**TS before → after.**

```ts
// before
if (date.isBefore(plan.summerStart) || date.isAfter(plan.summerEnd)) {
  charge = qty * plan.regularRate;
} else {
  charge = qty * plan.summerRate;
}
```

```ts
// after
charge = isSummer(date, plan) ? qty * plan.summerRate : qty * plan.regularRate;

function isSummer(date: PlainDate, plan: BillingPlan): boolean {
  return !date.isBefore(plan.summerStart) && !date.isAfter(plan.summerEnd);
}
```

**Enough on its own when.** The branches were always going to be exactly these two cases. If a third or fourth case is genuinely likely to join later and each will carry its own behavior, that's when Replace Conditional with Polymorphism earns its keep — not before.

### Consolidate Conditional Expression

**Removes.** Several conditions in a row that all lead to the same result, obscuring that they're really one check.

**Mechanics.**

- Confirm the conditions are independent (no side effects between them) and all produce the same outcome.
- Combine them with `&&`/`||` into a single expression.
- Extract that expression into a named function if it's still hard to read (see Extract Function).

**TS before → after.**

```ts
// before
function isEligibleForRefund(order: Order): boolean {
  if (order.status === 'cancelled') return true;
  if (order.deliveryFailed) return true;
  if (order.customer.isTestAccount) return true;
  return false;
}
```

```ts
// after
function isEligibleForRefund(order: Order): boolean {
  return order.status === 'cancelled' || order.deliveryFailed || order.customer.isTestAccount;
}
```

**Enough on its own when.** All branches truly converge on one outcome with no distinct behavior per condition. If each condition instead triggers different follow-up logic, you don't have one check to consolidate — you may have a dispatch problem, which is a different smell.

### Replace Nested Conditional with Guard Clauses

**Removes.** A pyramid of nested `if`s where only the deepest branch is the "normal" path, burying the actual logic under exit-condition handling.

**Mechanics.**

- For each condition that should short-circuit the function, turn it into an early `return`/`throw` at the top.
- Remove the `else` — once a guard has returned, the rest of the function is implicitly the else branch.
- Leave the main logic unindented at the end.

**TS before → after.**

```ts
// before
function shippingCost(order: Order): number {
  if (order.customer) {
    if (order.customer.isActive) {
      if (order.lines.length > 0) {
        return computeCost(order);
      } else {
        return 0;
      }
    } else {
      throw new Error('inactive customer');
    }
  } else {
    throw new Error('no customer');
  }
}
```

```ts
// after
function shippingCost(order: Order): number {
  if (!order.customer) throw new Error('no customer');
  if (!order.customer.isActive) throw new Error('inactive customer');
  if (order.lines.length === 0) return 0;
  return computeCost(order);
}
```

**Enough on its own when.** The nesting was purely about validating preconditions before the real work. This is almost never a design-pattern situation — flattening the guards is the whole fix.

### Replace Conditional with Polymorphism

**Removes.** The same `switch`/`if` chain on a type or kind field, repeated across multiple methods or call sites, where each branch implements clearly distinct behavior for that kind.

**Mechanics.**

- Confirm the conditional (or one very like it) recurs in more than one place — a single occurrence doesn't justify this move (see Decompose Conditional instead).
- Give each variant its own function/handler keyed by kind, e.g. a `Record<Kind, fn>` lookup or a discriminated union with an exhaustive `switch` in one place.
- Replace each call site's repeated conditional with a call through the lookup/dispatch.

**TS before → after.**

```ts
// before, repeated in render(), validate(), and export()
function feeFor(kind: 'wire' | 'ach' | 'card', cents: number): number {
  if (kind === 'wire') return 2500;
  if (kind === 'ach') return 0;
  return Math.round(cents * 0.029);
}
```

```ts
// after — one dispatch table, referenced everywhere instead of re-branching
const feeCalculators: Record<'wire' | 'ach' | 'card', (cents: number) => number> = {
  wire: () => 2500,
  ach: () => 0,
  card: (cents) => Math.round(cents * 0.029),
};
```

**Enough on its own when.** A lookup table or exhaustive `switch` in one place is already the fix for "logic branches on kind." If the variant needs to be swapped at _runtime_ by the caller (not just looked up by a fixed key), or needs its own injected dependencies/lifecycle, that's the point where this becomes the **Strategy** or **State** pattern — see `behavioral.md`. Don't build the class hierarchy until you actually need runtime substitution.

## Organizing data

### Replace Magic Number with Symbolic Constant

**Removes.** A bare literal whose meaning only exists in the author's head, repeated at every use site.

**Mechanics.**

- Name the literal for what it represents.
- Declare it as a `const` near its point of use, or in shared config if genuinely shared.
- Replace every occurrence of the literal with the named constant.

**TS before → after.**

```ts
// before
if (session.idleMs > 900_000) invalidateSession(session);
```

```ts
// after
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
if (session.idleMs > SESSION_IDLE_TIMEOUT_MS) invalidateSession(session);
```

**Enough on its own when.** The value never varies by context — one true value, one name. If different tenants/environments/plans need different values, that's a config/parameter concern, not a reason to add a pattern.

### Replace Temp with Query

**Removes.** A local variable that just caches a computed value, forcing every related method to recompute or thread the same intermediate value around.

**Mechanics.**

- Extract the computation into a function (see Extract Function).
- Replace reads of the temp variable with calls to the new function.
- Delete the temp variable and its assignment.

**TS before → after.**

```ts
// before
function describe(order: Order): string {
  const basePrice = order.qty * order.unitPriceCents;
  if (basePrice > 100_00) return `Large order: ${basePrice}`;
  return `Order: ${basePrice}`;
}
```

```ts
// after
function describe(order: Order): string {
  if (basePrice(order) > 100_00) return `Large order: ${basePrice(order)}`;
  return `Order: ${basePrice(order)}`;
}

function basePrice(order: Order): number {
  return order.qty * order.unitPriceCents;
}
```

**Enough on its own when.** The computation is cheap enough to repeat and other methods on the same type will want it too. If it's expensive and called often, memoize inside the query function — that's still just a function, not a pattern.

### Introduce Parameter Object

**Removes.** A long, easy-to-misorder parameter list that keeps growing, and often gets passed as-is from one function to the next (a data clump).

**Mechanics.**

- Identify the parameters that always travel together.
- Group them into one named `type`.
- Update the function signature and call sites to pass the object instead of the individual fields.

**TS before → after.**

```ts
// before
function searchOrders(status: string, fromDate: Date, toDate: Date, page: number, pageSize: number) { ... }
```

```ts
// after
type OrderSearchQuery = { status: string; fromDate: Date; toDate: Date };
type Pagination = { page: number; pageSize: number };

function searchOrders(query: OrderSearchQuery, pagination: Pagination) { ... }
```

**Enough on its own when.** The parameters have no behavior of their own — they're just data that travels together. If the new object also needs to _validate itself_ or expose behavior beyond grouping, consider whether that belongs on the object as a method before reaching for a Builder; only escalate to Builder once construction actually has staged/order-dependent steps (see `creational.md`).

### Preserve Whole Object

**Removes.** A function that pulls several individual fields off the same object just to pass them along separately, then has to be re-edited every time a new field from that object is needed.

**Mechanics.**

- Change the function's parameter from the individual fields to the whole source object.
- Have the function read the fields it needs directly off that object.
- Update call sites to pass the object instead of destructured fields.

**TS before → after.**

```ts
// before
function isWithinRange(low: number, high: number, plan: Plan): boolean {
  return plan.tempRange.low >= low && plan.tempRange.high <= high;
}
isWithinRange(plan.tempRange.low, plan.tempRange.high, plan);
```

```ts
// after
function isWithinRange(range: TempRange, plan: Plan): boolean {
  return plan.tempRange.low >= range.low && plan.tempRange.high <= range.high;
}
isWithinRange(plan.tempRange, plan);
```

**Enough on its own when.** The function only needed a couple of fields off one object as a shortcut. If you're routinely reconstructing the same _combination of fields from several different objects_, that's Introduce Parameter Object instead — not a reason for anything heavier.

## Moving features

### Move Function

**Removes.** Feature envy — a function that reaches into another object's data more than its own, or lives farther from the data it operates on than it should.

**Mechanics.**

- Identify the object/module the function actually depends on most.
- Copy the function there, adjusting it to use that context directly instead of reaching in from outside.
- Either turn the original into a thin delegator, or update callers and delete it.

**TS before → after.**

```ts
// before, defined in InvoiceService but only ever touches Order
function totalWithTax(order: Order): number {
  return order.lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0) * 1.0825;
}
```

```ts
// after, moved onto the class/module that owns the data
class Order {
  totalWithTax(): number {
    return this.lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0) * 1.0825;
  }
}
```

**Enough on its own when.** The fix is purely "this logic lives in the wrong place." Moving it next to its data resolves feature envy directly — don't reach for Mediator or Facade to paper over misplaced logic; move the logic first and see if the coupling problem is still there afterward.

### Split Loop

**Removes.** One loop doing two unrelated jobs at once (e.g. summing totals and collecting flagged items in the same pass), making each job harder to name, test, or change independently.

**Mechanics.**

- Duplicate the loop so each copy does one job.
- Delete the unrelated statements from each copy.
- Extract each resulting loop into a named function if it clarifies intent (see Extract Function).

**TS before → after.**

```ts
// before
let total = 0;
const flagged: Order[] = [];
for (const order of orders) {
  total += order.amountCents;
  if (order.amountCents > 100_00) flagged.push(order);
}
```

```ts
// after
const total = orders.reduce((sum, o) => sum + o.amountCents, 0);
const flagged = orders.filter((o) => o.amountCents > 100_00);
```

**Enough on its own when.** Each resulting pass has one clear job and the collection is small enough that two passes over it is a non-issue. If you're tempted to make the traversal itself pluggable/reusable across many different "jobs," check whether a generator (native Iterator, see `behavioral.md`) is a lighter fit before anything more elaborate.
