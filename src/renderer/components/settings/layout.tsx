import type { ReactNode } from "react";

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-page">{title}</h2>
        {description && (
          <p className="max-w-[72ch] text-body text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({
  children,
  ...props
}: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div
      {...props}
      className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card"
    >
      {children}
    </div>
  );
}

/** A title and its words, then the row's controls under them on the right. Controls wide enough to need their own line would otherwise wrap under while narrow ones sat beside, so every row puts them in the same place. */
export function SettingsRow({
  title,
  description,
  control,
  children,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div {...props} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex max-w-[72ch] min-w-0 flex-col gap-0.5">
        <h3 className="flex min-h-5 items-center gap-2 text-body font-medium">{title}</h3>
        {description && <div className="text-meta text-muted-foreground">{description}</div>}
      </div>
      {control && <div className="flex flex-wrap items-center justify-end gap-2">{control}</div>}
      {children}
    </div>
  );
}
