/** One exact passage. Editing a fix edits only `after`. An insert has an empty `before`. */
export interface Splice {
  prefix: string;
  before: string;
  after: string;
  suffix: string;
}
export type SpliceState = "already-there" | "ready" | "moved";

const MIN_CONTEXT = 8;
const PARAGRAPH_BREAK = "\n\n";

/** Overlaps count, so a run like "aaa" cannot pass as unique context. Empty text only matches an empty body. */
const countOf = (body: string, text: string): number => {
  if (text === "") return body === "" ? 1 : 0;
  let count = 0;
  for (let at = body.indexOf(text); at !== -1; at = body.indexOf(text, at + 1)) count++;
  return count;
};

export const paragraphBounds = (
  body: string,
  start: number,
  end: number,
): { start: number; end: number } => {
  const open = start === 0 ? -1 : body.lastIndexOf(PARAGRAPH_BREAK, start - 1);
  const close = body.indexOf(PARAGRAPH_BREAK, end);
  return {
    start: open === -1 ? 0 : Math.min(open + PARAGRAPH_BREAK.length, start),
    end: close === -1 ? body.length : close,
  };
};

/** Context stays inside the paragraph while that is unique, so a fix in the next paragraph leaves this splice valid. */
export const spliceAt = (body: string, index: number, length: number, after: string): Splice => {
  const end = index + length;
  const before = body.slice(index, end);
  const between = (from: number, to: number): Splice => ({
    prefix: body.slice(from, index),
    before,
    after,
    suffix: body.slice(end, to),
  });
  const isUnique = ({ prefix, suffix }: Splice) => countOf(body, prefix + before + suffix) === 1;
  const paragraph = paragraphBounds(body, index, end);
  for (let reach = MIN_CONTEXT; ; reach *= 2) {
    const from = Math.max(0, index - reach);
    const to = Math.min(body.length, end + reach);
    const inParagraph = between(Math.max(from, paragraph.start), Math.min(to, paragraph.end));
    if (isUnique(inParagraph)) return inParagraph;
    const wide = between(from, to);
    if (isUnique(wide) || (from === 0 && to === body.length)) return wide;
  }
};

/**
 * Already-there comes before ready because an insert's context survives its own write, and a retry must not write twice.
 * The first line keeps a look-alike elsewhere from reading as landed while this passage is still unchanged.
 */
export const spliceState = (
  body: string,
  { prefix, before, after, suffix }: Splice,
): SpliceState => {
  const was = prefix + before + suffix;
  const will = prefix + after + suffix;
  const once = countOf(body, was) === 1;
  if (once && !will.includes(was)) return "ready";
  if (body.includes(will)) return "already-there";
  return once ? "ready" : "moved";
};

/** An insert after existing text opens with a paragraph break. The break is layout, so a person edits only the words after it. */
export const editableAfter = ({ before, after }: Splice): { lead: string; words: string } => {
  const lead = before === "" && after.startsWith(PARAGRAPH_BREAK) ? PARAGRAPH_BREAK : "";
  return { lead, words: after.slice(lead.length) };
};

/** The body with the passage rewritten. A body without the passage comes back unchanged, so a landed splice is a no-op here. */
export const applySplice = (body: string, { prefix, before, after, suffix }: Splice): string => {
  const at = body.indexOf(prefix + before + suffix);
  return at === -1
    ? body
    : body.slice(0, at + prefix.length) + after + body.slice(at + prefix.length + before.length);
};

/** The paragraph holding the new text, as it will read. A passage that moved has only its own context to show. */
export const paragraphAfter = (body: string, splice: Splice): string => {
  const { prefix, before, after, suffix } = splice;
  const state = spliceState(body, splice);
  if (state === "moved") return (prefix + after + suffix).trim();
  const at = body.indexOf(prefix + (state === "ready" ? before : after) + suffix);
  const start = at + prefix.length;
  const read =
    state === "ready" ? body.slice(0, start) + after + body.slice(start + before.length) : body;
  const lead = after.length - after.trimStart().length;
  const bounds = paragraphBounds(
    read,
    start + lead,
    start + Math.max(lead, after.trimEnd().length),
  );
  return read.slice(bounds.start, bounds.end).trim();
};
