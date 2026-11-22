export const SAMPLE_PACKAGES = [
  { key: "comm110", name: "comm110-lakeshore-fall2026-export.imscc" },
  { key: "eng210", name: "eng210-northgate-spring2026-export.imscc" },
  { key: "damaged", name: "damaged-export.imscc" },
] as const;

export type SamplePackageKey = (typeof SAMPLE_PACKAGES)[number]["key"];
