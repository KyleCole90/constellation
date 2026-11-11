import { withoutFloatNoise } from "~/shared/domain/change";

export const parseScore = (text: string, outOf: number): number | null => {
  const trimmed = text.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return Math.min(outOf, Math.max(0, Number(trimmed)));
};

export const stepScore = (value: number | null, by: 1 | -1, outOf: number): number =>
  value === null ? 0 : Math.min(outOf, Math.max(0, withoutFloatNoise(value + by)));
