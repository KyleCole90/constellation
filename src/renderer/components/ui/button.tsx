import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";

import { cn } from "~/renderer/lib/utils";

// One disabled look for every variant: a quiet neutral fill and a muted label, with no brand colour, so it never reads as pressed.
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-medium transition-colors disabled:cursor-not-allowed disabled:border-transparent disabled:bg-muted disabled:text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground not-disabled:hover:bg-primary/90",
        outline: "border-input bg-secondary text-foreground not-disabled:hover:bg-foreground/12",
        ghost: "border-transparent text-foreground not-disabled:hover:bg-accent",
        "ghost-muted":
          "border-transparent text-muted-foreground not-disabled:hover:bg-accent not-disabled:hover:text-foreground",
        "ghost-info": "border-transparent text-info-foreground not-disabled:hover:bg-accent",
        selected:
          "border-transparent bg-selected text-foreground not-disabled:hover:bg-accent not-disabled:hover:text-foreground",
        link: "link border-transparent",
        "destructive-outline":
          "border-input bg-secondary text-error-foreground not-disabled:hover:bg-error/10",
      },
      size: {
        sm: "h-btn-sm px-2.5 text-body",
        meta: "h-btn-sm px-2.5 text-meta",
        md: "h-btn-md px-3 text-body",
        lg: "h-btn-lg px-4 text-body",
        icon: "size-btn-sm",
        "icon-round": "size-btn-sm rounded-full",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
