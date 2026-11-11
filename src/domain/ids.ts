export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SchoolId = Brand<string, "SchoolId">;
export type ChangeId = Brand<string, "ChangeId">;
export type ThreadId = Brand<string, "ThreadId">;
export type IsoTime = Brand<string, "IsoTime">;

/** The one way to make an IsoTime: a clock reading, a Date, or text `Date` can read. Throws on an invalid time, as `toISOString` does. */
export const isoTime = (at: number | string | Date): IsoTime =>
  // The single mint: toISOString always writes the brand's format.
  new Date(at).toISOString() as IsoTime;

/** For a timestamp from outside the app: null when it isn't one. */
export const parseIsoTime = (text: string): IsoTime | null =>
  Number.isNaN(Date.parse(text)) ? null : isoTime(text);
/** A calendar day, YYYY-MM-DD, with no time or zone. */
export type IsoDate = Brand<string, "IsoDate">;

/**
 * Vendor identity for one LMS object. Minted on read and parsed only by the provider that minted it,
 * because Canvas uses numeric ids and another LMS may not.
 * Providers embed the school id, so a ref is unique across schools.
 */
export type LmsRef<K extends string> = Brand<string, `LmsRef<${K}>`>;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** The address a school signs in at, as `school.example.edu`. Only `parseSchoolHost` makes one. */
export type SchoolHost = Brand<string, "SchoolHost">;

/** Takes what a person typed or pasted, scheme and path included. The error never repeats the input, because a pasted token can land here by mistake. */
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
  return { ok: true, value: host as SchoolHost };
};
