/** Compile-time exhaustiveness guard — a switch/if-chain that reaches this with `x` still narrowed to
 *  `never` proves every union member was handled; adding a new member without a case is a TS build error. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
