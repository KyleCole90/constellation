import mark from "~/renderer/assets/mark.svg";

export const PRODUCT_NAME = "Constellation";

export function Brand() {
  return (
    <div className="flex items-center gap-2">
      <img src={mark} alt="" className="size-5" />
      <span className="text-body font-medium rail:sr-only">{PRODUCT_NAME}</span>
    </div>
  );
}

export function SchoolStar({ school }: { school: string }) {
  return (
    <svg
      data-school-star={school}
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-3 flex-none"
      style={{ color: `var(--school-${school}, var(--muted-foreground))` }}
    >
      <path
        fill="currentColor"
        d="M6 0c.4 3.6 2.4 5.6 6 6-3.6.4-5.6 2.4-6 6-.4-3.6-2.4-5.6-6-6 3.6-.4 5.6-2.4 6-6Z"
      />
    </svg>
  );
}
