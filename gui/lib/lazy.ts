// An object whose properties are read through functions, at the moment they're read. What a page
// split into parts hands each part: a part reads the page's names when it uses them, as the
// closure it was split from did (so a name defined later is there by the time it's used).

type Gets = Record<string, () => unknown>;
type Vars = Record<string, readonly [get: () => unknown, set: (v: never) => void]>;
type Lazy<G extends Gets, V extends Vars> = { readonly [K in keyof G]: ReturnType<G[K]> } & {
  -readonly [K in keyof V]: ReturnType<V[K][0]>;
};

/** Properties read through `gets`, and read and written through `vars` ([get, set] pairs). */
export function lazy<G extends Gets, V extends Vars = Record<never, never>>(gets: G, vars?: V): Lazy<G, V> {
  const o = {};
  for (const [k, get] of Object.entries(gets)) Object.defineProperty(o, k, { get, enumerable: true });
  for (const [k, [get, set]] of Object.entries(vars ?? {}))
    Object.defineProperty(o, k, { get, set: set as (v: unknown) => void, enumerable: true });
  return o as Lazy<G, V>; // (built property by property above)
}
