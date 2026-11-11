import type { Rationale } from "~/shared/domain/change";

export interface Mark {
  key: string;
  start: number;
  end: number;
}
export interface Segment {
  text: string;
  start: number;
  /** Every criterion covering this run. Empty for plain text, more than one where anchors overlap. */
  keys: readonly string[];
  opens: readonly string[];
}

/** Splits at every anchor boundary, so overlapping passages become separate spans instead of nested or lost ones. */
export const segmentParagraph = (text: string, marks: readonly Mark[]): readonly Segment[] => {
  const usable = marks
    .map((mark) => ({
      ...mark,
      start: Math.max(mark.start, 0),
      end: Math.min(mark.end, text.length),
    }))
    .filter((mark) => mark.start < mark.end);
  const cuts = [
    ...new Set([0, text.length, ...usable.flatMap((mark) => [mark.start, mark.end])]),
  ].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i] as number;
    const end = cuts[i + 1] as number;
    const covering = usable.filter((mark) => mark.start <= start && mark.end >= end);
    segments.push({
      text: text.slice(start, end),
      start,
      keys: [...new Set(covering.map((mark) => mark.key))],
      opens: [...new Set(covering.filter((mark) => mark.start === start).map((mark) => mark.key))],
    });
  }
  return segments;
};

export const marksByParagraph = (
  rationale: readonly Rationale[],
): ReadonlyMap<number, readonly Mark[]> => {
  const byParagraph = new Map<number, Mark[]>();
  for (const { field, anchors } of rationale) {
    for (const anchor of anchors) {
      const marks = byParagraph.get(anchor.paragraph) ?? [];
      marks.push({ key: field, start: anchor.start, end: anchor.end });
      byParagraph.set(anchor.paragraph, marks);
    }
  }
  return byParagraph;
};

/** Clicking an overlapped passage cycles through what covers it, so every criterion stays reachable. */
export const nextCriterion = (keys: readonly string[], selected: string | null): string | null => {
  const index = selected === null ? -1 : keys.indexOf(selected);
  return keys[(index + 1) % keys.length] ?? null;
};

export const criterionNumbers = (
  order: readonly string[],
  rationale: readonly Rationale[],
): ReadonlyMap<string, number> =>
  new Map(
    order
      .filter((key) => rationale.some((entry) => entry.field === key && entry.anchors.length > 0))
      .map((key, index) => [key, index + 1]),
  );

const HUES = 4;
/** Keyed by the number a criterion shows, so its badges and passages always share one hue. */
export const criterionHue = (number: number): string => `var(--crit-${((number - 1) % HUES) + 1})`;
