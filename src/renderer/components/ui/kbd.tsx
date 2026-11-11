import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "~/renderer/lib/utils";

const kbdVariants = cva("rounded border px-1 py-0.5 font-sans text-meta whitespace-nowrap", {
  variants: {
    variant: {
      default: "border-input text-muted-foreground",
      "on-primary": "border-primary-foreground/25 text-current",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Kbd({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLElement> & VariantProps<typeof kbdVariants>) {
  return <kbd className={cn(kbdVariants({ variant }), className)} {...props} />;
}
