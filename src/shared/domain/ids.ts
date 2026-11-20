export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SchoolId = Brand<string, "SchoolId">;
export type ChangeId = Brand<string, "ChangeId">;
export type ThreadId = Brand<string, "ThreadId">;
export type IsoTime = Brand<string, "IsoTime">;

export const isoTime = (at: number | string | Date): IsoTime =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, constellation/use-iso-time -- the mint: toISOString always writes the brand's format
  new Date(at).toISOString() as IsoTime;

export const parseIsoTime = (text: string): IsoTime | null =>
  Number.isNaN(Date.parse(text)) ? null : isoTime(text);

export const parseSchoolId = (raw: string): SchoolId | null =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the test before it is the brand's check
  raw === "" || raw.includes(":") ? null : (raw as SchoolId);

export type IsoDate = Brand<string, "IsoDate">;

export type LmsRef<K extends string> = Brand<string, `LmsRef<${K}>`>;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type SchoolHost = Brand<string, "SchoolHost">;

export const parseSchoolHost = (raw: string): Result<SchoolHost, string> => {
  const host = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "") return { ok: false, error: "Type the address you sign in at." };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(host))
    return {
      ok: false,
      error: "That isn't a web address. Type the address you sign in at, with a dot in it.",
    };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mint: the regex above is the brand's check
  return { ok: true, value: host as SchoolHost };
};

export const schoolIdOf = (host: SchoolHost): SchoolId | null => parseSchoolId(host);
