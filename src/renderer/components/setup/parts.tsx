import type { ReactNode } from "react";

import { cn } from "~/renderer/lib/utils";

import { CARD_CLASS, FOOTER_CLASS } from "./styles";

export function Card({
  title,
  testId,
  footer,
  children,
}: {
  title: string;
  testId?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className={CARD_CLASS}>
      <h3 className="text-title">{title}</h3>
      {children}
      {footer && (
        <div data-action-bar className={cn(FOOTER_CLASS, "-mx-card -mb-card")}>
          {footer}
        </div>
      )}
    </section>
  );
}

export function Refusal({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-meta text-error-foreground">
      {text}
    </p>
  ) : null;
}

export function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p data-testid={testId} className="text-meta text-muted-foreground">
      {children}
    </p>
  );
}
