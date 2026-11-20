export const keysOf = <K extends string>(record: Partial<Record<K, unknown>>): K[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own keys: every caller's record holds only keys of K
  Object.keys(record) as K[];
