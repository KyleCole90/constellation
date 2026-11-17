import * as v from "valibot";

import { isoTime, parseIsoTime, type IsoTime } from "../../shared/domain/ids";

// ---- The scalars Canvas sends, per its public API docs, shared by every Canvas read. ----

export const Id = v.pipe(v.number(), v.integer());
export const Time = v.pipe(
  v.string(),
  v.check((raw) => parseIsoTime(raw) !== null),
  v.transform((raw): IsoTime => isoTime(raw)),
);
export const OptionalTime = v.nullish(Time, null);
