/** A plain object, read key by key before a schema or a migration knows its shape. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
