/** `Object.keys`, typed by the record's key set. Only for records the app builds or parses over that set, never for a structural subtype with extra keys. */
export const keysOf = <K extends string>(record: Partial<Record<K, unknown>>): K[] =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own keys: every caller's record holds only keys of K
  Object.keys(record) as K[];
