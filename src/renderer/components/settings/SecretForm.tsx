import { useRef, useState, type FormEvent, type ReactNode, type RefCallback } from "react";

import { cn } from "~/renderer/lib/utils";
import { Secret, type SecretRefusal } from "~/shared/providers/provider";

import { Button } from "../ui/button";

const FIELD =
  "rounded-control border border-input bg-background px-field-x font-mono text-body text-foreground outline-none placeholder:text-tertiary-label focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The only place the app takes a secret from a person. The input stays uncontrolled, so the value never reaches React
 * state and is never rendered. It stays in the field, read-only, while `onSubmit` runs, and is emptied once the secret
 * is taken or proved wrong; any other refusal leaves it there to try again.
 * `onSubmit` answers with a refusal safe to show, or null when it worked.
 * `inputRef` lets a demo fill write the field directly, so a filled value never passes through React state either.
 * An error speaks to the `context` it was raised under, so a new context retires it.
 * The inline layout puts the field, `aside`, and the buttons on one line, for a row in a list. While busy, `progress`
 * takes the place of `aside`, so the row keeps its height.
 */
export function SecretForm({
  fieldLabel,
  submitLabel,
  busyLabel,
  onSubmit,
  secondary,
  aside,
  progress,
  children,
  layout = "stacked",
  inputRef,
  context,
  lands,
}: {
  fieldLabel: string;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (secret: Secret) => Promise<SecretRefusal | null>;
  secondary?: { label: string; make: () => Secret };
  aside?: ReactNode;
  progress?: ReactNode;
  children?: ReactNode;
  layout?: "stacked" | "inline";
  inputRef?: RefCallback<HTMLInputElement>;
  context?: string;
  /** Where focus goes once the submit takes the form off the page. */
  lands?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [said, setSaid] = useState<{ text: string; context: string | undefined } | null>(null);
  const error = said && said.context === context ? said.text : null;
  const [busy, setBusy] = useState(false);

  const run = async (secret: Secret, fromField: boolean) => {
    setBusy(true);
    setSaid(null);
    const refusal = await onSubmit(secret);
    setBusy(false);
    setSaid(refusal === null ? null : { text: refusal.message, context });
    if (fromField && input.current && (refusal === null || refusal.wrongSecret))
      input.current.value = "";
    if (refusal) input.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const field = input.current;
    if (!field || busy) return;
    void run(new Secret(field.value), true);
  };

  const attach = (element: HTMLInputElement | null) => {
    input.current = element;
    inputRef?.(element);
  };
  const field = (
    <input
      ref={attach}
      type="password"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      readOnly={busy}
      {...(layout === "inline" ? { "aria-label": fieldLabel, placeholder: fieldLabel } : {})}
      className={cn(FIELD, layout === "inline" ? "h-btn-md min-w-0 flex-1" : "h-field")}
    />
  );
  const problem = error && (
    <p role="alert" className="text-meta text-error-foreground">
      {error}
    </p>
  );
  const secondaryButton = secondary && (
    <Button
      variant="ghost-muted"
      size={layout === "inline" ? "md" : "lg"}
      disabled={busy}
      onClick={() => void run(secondary.make(), false)}
    >
      {secondary.label}
    </Button>
  );

  if (layout === "inline")
    return (
      <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-1.5">
        {children}
        <div className="flex items-center gap-2">
          {field}
          {busy && progress ? progress : aside}
          {secondaryButton}
          <Button type="submit" variant="outline" size="md" disabled={busy} data-lands={lands}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
        {problem}
      </form>
    );

  return (
    <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-card-gap">
      {children}
      <label className="flex flex-col gap-label-gap text-meta text-secondary-label">
        {fieldLabel}
        {field}
      </label>
      {problem}
      {busy && progress}
      <div className="flex items-center justify-end gap-btn-gap">
        {!busy && aside && <div className="mr-auto">{aside}</div>}
        {secondaryButton}
        <Button type="submit" variant="default" size="lg" disabled={busy}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
