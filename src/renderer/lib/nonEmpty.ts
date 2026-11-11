/** A list that has a first item, so `[0]` needs no check. */
export type NonEmpty<T> = readonly [T, ...T[]];

export const lastOf = <T>(items: NonEmpty<T>): T => items[items.length - 1] ?? items[0];
