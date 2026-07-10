---
name: design-patterns
description: Recognize code smells and apply the RIGHT design pattern with restraint — boring refactoring first, a named Gang-of-Four pattern only when it earns its keep. Use whenever writing or refactoring non-trivial code, when you are fighting the existing structure to add a feature, or when you notice duplication, a giant class/function, tangled conditionals, shotgun-surgery edits, feature envy, or a data/behavior mismatch — or when the user mentions "design pattern," "refactor," "code smell," "clean this up," "too complex," "over-engineered," Strategy, Factory, Observer, Adapter, Decorator, State, Command, or any GoF pattern by name.
metadata:
  trigger: Writing or refactoring non-trivial code, or noticing a code smell
  version: 1.0.0
---

# Design Patterns

A design pattern is the *cure*; a code smell is the *diagnosis*. Applied without a smell, a pattern is just over-engineering — more indirection to read, maintain, and get wrong. This skill rides on top of "write the least code that solves the problem": a pattern is only leaner than the boring alternative when a real smell justifies it. Diagnose first. Reach for a named pattern last.

## The one rule: diagnose before you pattern

Never reach for a pattern by name first ("let's use a Factory here"). Name the **smell**, then climb the response ladder. If you can't name the smell, you don't need the pattern. Depth for each pattern lives in `references/creational.md`, `references/structural.md`, and `references/behavioral.md` — pull one in only once you've named a smell it removes.

## The response ladder

1. **Does this complexity need to exist?** Delete it, simplify the requirement, or say no. The best pattern is no code.
2. **Boring refactoring first.** Extract a named function, rename for intent, inline a needless indirection, replace a magic number with a constant, add a guard clause, introduce a parameter object. Most "I need a pattern" moments end here.
3. **The minimum named pattern** — only if the smell survives step 2, and only the smallest one that fits. Match the intent, not the label.
4. **Never** a pattern with a single caller or a single implementation. A Strategy with one strategy, a Factory that makes one type, an interface with one implementer — that is a smell you are *adding*, not removing.

## The five smell families → what to reach for

This is the smell → response index. Name the family first; the boring refactor is always the first move, and a pattern only if it survives.

- **Bloaters** (giant class/function, long parameter list, primitive obsession, data clumps): first extract function/class and introduce a parameter object. If behavior varies by type → **Strategy** / **State**; if construction is complex or has many optional steps → **Builder**. See `references/behavioral.md`, `references/creational.md`.
- **Object-Orientation Abusers** (`switch` on a type code, refused bequest, temporary field, alternative classes with different interfaces): replace the conditional with polymorphism → **Strategy**, **State**, or **Template Method**; reconcile mismatched interfaces with **Adapter**. See `references/behavioral.md`, `references/structural.md`.
- **Change Preventers** (Divergent Change — one class changes for many reasons; Shotgun Surgery — one change edits many classes): this is the **refactor-the-pattern** signal, not a conform signal. Separate the axes of change → **Strategy**, **Bridge**, **Observer**, or **Facade**. See "Consistency, not conformance" below.
- **Dispensables** (duplication, dead code, speculative generality, a comment that restates the code, lazy/data class): delete and dedupe. Usually **NO pattern** — resist adding one. If you already have a single-caller Strategy/Factory/interface here, *collapse* it back to plain code.
- **Couplers** (feature envy, inappropriate intimacy, message chains, middle man): move behavior to the data it envies, or decouple with **Mediator**, **Facade**, or **Adapter**. See `references/structural.md`, `references/behavioral.md`.

## Consistency, not conformance

Matching how the codebase already does something is the tiebreaker for **incidental** choices — it is not a cage. When the existing pattern strains under a new requirement (a **Change-Preventer** smell — you're fighting the structure to add the feature), that is the cue to **migrate the pattern**, not to bolt a hack onto it and not to silently introduce a third inconsistent way.

When you migrate:

- Do it **completely** — move the callers too. A codebase half in the old pattern and half in the new is worse than either. Never leave a migration half-done.
- Keep it **scoped** to what the change actually needs.
- **Surface** a large-blast-radius refactor (flag a decision or a ticket) instead of ballooning the diff or hacking around the old shape.

## Choosing the pattern (index → references)

| You see… | Try first | Then consider | Reference |
|---|---|---|---|
| `switch`/`if` on a type code, behavior varies by kind | polymorphism / a lookup map | Strategy, State | behavioral.md |
| Complex object built in steps / many optional args | parameter object | Builder | creational.md |
| Family of related objects made together | a factory function | Abstract Factory, Factory Method | creational.md |
| Incompatible interface at a boundary | a thin wrapper fn | Adapter, Facade | structural.md |
| Add behavior without touching the class | composition / a wrapper fn | Decorator, Proxy | structural.md |
| Nested part/whole tree treated uniformly | recursion over a union | Composite | structural.md |
| Many objects react to one event | a callback list | Observer, Mediator | behavioral.md |
| A multi-step algorithm with varying steps | extract functions | Template Method, Strategy | behavioral.md |
| One change edits many classes | separate the axes | Bridge, Strategy | structural.md, behavioral.md |

## Reviewing existing code

- [ ] Is there a *nameable* smell, or is the current code already the simplest thing that works?
- [ ] Is every abstraction earning its keep — more than one real caller/implementation?
- [ ] Is there a single-caller pattern to **collapse** back into plain code?
- [ ] Is a pattern migration half-done (old and new shapes coexisting)?
- [ ] Does the change fight the existing structure? If so, migrate deliberately and completely — don't hack around it, don't add a third way.
