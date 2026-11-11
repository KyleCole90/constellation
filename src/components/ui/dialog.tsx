import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

export const Dialog = BaseDialog.Root;
export const DialogClose = BaseDialog.Close;

const dialogPopupVariants = cva(
  "fixed top-[14vh] left-1/2 z-50 w-[min(460px,90vw)] -translate-x-1/2 rounded-xl border border-input bg-popover shadow-dialog outline-none",
  {
    variants: {
      variant: {
        default: "flex flex-col gap-card-gap p-card",
        bare: "",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function DialogPopup({
  className,
  variant,
  children,
  ...props
}: ComponentProps<typeof BaseDialog.Popup> &
  VariantProps<typeof dialogPopupVariants> & { children: ReactNode }) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop data-scrim className="fixed inset-0 z-40 bg-black/50" />
      <BaseDialog.Popup className={cn(dialogPopupVariants({ variant }), className)} {...props}>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof BaseDialog.Title>) {
  return <BaseDialog.Title className={cn("text-title", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      className={cn("text-body text-muted-foreground", className)}
      {...props}
    />
  );
}
