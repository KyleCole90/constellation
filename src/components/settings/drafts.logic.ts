import { parseSchoolHost, type SchoolHost } from "~/domain/ids";

/** Reads the typed addresses an earlier visit to this tab kept. Anything that isn't a list of addresses reads as none. */
export const readDraftHosts = (raw: string | null): readonly SchoolHost[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hosts = parsed.flatMap((item) => {
    const host = typeof item === "string" ? parseSchoolHost(item) : null;
    return host?.ok ? [host.value] : [];
  });
  return [...new Set(hosts)];
};

/** Rows in the order their keys were first placed. A row not placed yet goes last. */
export const placeRows = <Row extends { key: string }>(
  rows: readonly Row[],
  placed: readonly string[],
): Row[] => {
  const place = (row: Row) => {
    const at = placed.indexOf(row.key);
    return at === -1 ? placed.length : at;
  };
  return rows.toSorted((a, b) => place(a) - place(b));
};
