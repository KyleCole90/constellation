import type { faultLab } from "~/renderer/stores/workspace";

export type Noise = ReturnType<ReturnType<typeof faultLab>["noise"]>;

export interface NoiseDial {
  key: "rate429" | "rate5xx" | "rateLost" | "fastest" | "slowest";
  label: string;
  words: string;
  max: number;
  step: number;
  unit: "%" | " ms";
}

export const NOISE_DIALS: readonly NoiseDial[] = [
  {
    key: "rate429",
    label: "Rate limited",
    words: "Requests answered with a 429",
    max: 50,
    step: 0.5,
    unit: "%",
  },
  {
    key: "rate5xx",
    label: "Server errors",
    words: "Requests answered with a 503",
    max: 50,
    step: 0.5,
    unit: "%",
  },
  {
    key: "rateLost",
    label: "Lost responses",
    words: "Writes that land but never answer",
    max: 50,
    step: 0.5,
    unit: "%",
  },
  {
    key: "fastest",
    label: "Fastest answer",
    words: "Shortest wait for any request",
    max: 3000,
    step: 50,
    unit: " ms",
  },
  {
    key: "slowest",
    label: "Slowest answer",
    words: "Longest wait for any request",
    max: 3000,
    step: 50,
    unit: " ms",
  },
];

const asPercent = (rate: number) => Math.round(rate * 1000) / 10;

export const dialValue = (noise: Noise, key: NoiseDial["key"]): number => {
  switch (key) {
    case "fastest":
      return noise.latencyMs[0];
    case "slowest":
      return noise.latencyMs[1];
    case "rate429":
    case "rate5xx":
    case "rateLost":
      return asPercent(noise[key]);
  }
};

/** The patch for moving one dial. Moving one latency end past the other pushes the other along, so the range stays a range. */
export const dialPatch = (noise: Noise, key: NoiseDial["key"], value: number): Partial<Noise> => {
  switch (key) {
    case "fastest":
      return { latencyMs: [value, Math.max(value, noise.latencyMs[1])] };
    case "slowest":
      return { latencyMs: [Math.min(value, noise.latencyMs[0]), value] };
    case "rate429":
    case "rate5xx":
    case "rateLost":
      return { [key]: value / 100 };
  }
};

export const parseGrade = (text: string): number | null => {
  const grade = Number(text);
  return text.trim() !== "" && Number.isFinite(grade) && grade >= 0 ? grade : null;
};
