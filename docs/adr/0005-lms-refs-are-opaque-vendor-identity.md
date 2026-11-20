# LMS refs are opaque vendor ids that only their provider reads

Every object from an LMS is named by an `LmsRef` that the provider mints on read and parses alone. Shared code and rules never take a vendor id or URL apart, so another LMS can use ids that aren't numbers.

- `LmsRef` in `src/shared/domain/ids.ts` is minted on read and parsed only by the provider that minted it. Each provider puts the school id in the ref, so a ref is unique across schools.
- `parseSchoolId` in `src/shared/domain/ids.ts` rejects an empty id or one that holds `:`. Every `LmsRef` starts with the school id and splits on `:`.
- `schoolIdOf` in `src/shared/domain/ids.ts` makes a Canvas school's id its host, so an id and a host can never name different schools. A host with a port gives null, because the id can't hold `:`.
- Canvas refs in `src/shared/providers/canvas-refs.ts` hold Canvas's numeric ids, and the item type for items, so `describe` and routes can build a real Canvas path with no lookup.
- `ContentLink.points` in `src/shared/domain/content.ts` is set by the provider, because URL grammar is vendor knowledge. Scan rules read only `points` and never parse a vendor URL.
- `GRADE_DRAFTS` in `src/shared/agent/rules/drafts.ts` keys rubric scores by criterion name, not criterion ref. The provider mints the ref, and the bank must work for any school's seed.
