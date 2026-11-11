import { ChevronRight, Paperclip } from "lucide-react";

import type { ChangeSummary } from "~/shared/domain/change";
import type { PreviewBody, PreviewField } from "~/shared/domain/preview";

import { Badge, type BadgeTone, type StatusIcon } from "../ui/badge";
import { fieldChip, type FieldChip } from "./writeback.logic";

const CHIP_TONE: Readonly<Record<FieldChip["tone"], BadgeTone>> = {
  working: "info",
  landed: "success",
  failed: "danger",
  unknown: "warning",
  waiting: "neutral",
};

const CHIP_ICON: Readonly<Partial<Record<FieldChip["tone"], StatusIcon>>> = {
  landed: "sent",
  failed: "error",
};

function Body({ body }: { body: PreviewBody }) {
  switch (body.kind) {
    case "grade":
      return (
        <p className="text-body">
          <b className="text-page font-semibold">{body.points}</b>{" "}
          <span className="text-muted-foreground">/ {body.outOf}</span>
        </p>
      );
    case "excused":
      return <p className="text-body">Excused. It won't count toward the student's grade.</p>;
    case "rubric":
      return (
        <ul className="flex flex-col gap-1 text-body">
          {body.rows.map((row) => (
            <li key={row.criterion} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="flex-none text-meta text-muted-foreground">{row.rating}</span>
              <span className="w-14 flex-none text-right tabular-nums">
                {row.points} <span className="text-muted-foreground">/ {row.outOf}</span>
              </span>
            </li>
          ))}
        </ul>
      );
    case "text":
      return (
        <div className="flex flex-col gap-1 text-body">
          {body.title && <p className="font-medium">{body.title}</p>}
          <p className="break-words whitespace-pre-wrap">{body.text}</p>
        </div>
      );
    case "attachment":
      return (
        <p className="flex items-center gap-1.5 text-body">
          <Paperclip className="size-3.5 flex-none text-muted-foreground" />
          <span className="min-w-0 truncate">{body.name}</span>
          <span className="flex-none text-meta text-muted-foreground">{body.kb} KB</span>
        </p>
      );
    case "passage":
      return (
        <div className="flex flex-col gap-1 text-body">
          <p className="text-meta text-muted-foreground">{body.where}</p>
          <p className="break-words whitespace-pre-wrap">{body.text}</p>
        </div>
      );
    case "copy":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body">
          <dt className="text-muted-foreground">From</dt>
          <dd>{body.source}</dd>
          <dt className="text-muted-foreground">Was</dt>
          <dd>{body.oldTerm}</dd>
          <dt className="text-muted-foreground">Becomes</dt>
          <dd>{body.newTerm}</dd>
          {body.days.length > 0 && (
            <>
              <dt className="text-muted-foreground">Days</dt>
              <dd>
                {body.days
                  .map((day) => (day.from === day.to ? day.from : `${day.from} becomes ${day.to}`))
                  .join(", ")}
              </dd>
            </>
          )}
          {body.breaks.length > 0 && (
            <>
              <dt className="text-muted-foreground">Breaks</dt>
              <dd>{body.breaks.join("; ")}</dd>
            </>
          )}
          {body.occupied && (
            <dd data-occupied className="col-span-2 text-warning-foreground">
              This course already has {body.occupied.students} student
              {body.occupied.students === 1 ? "" : "s"} and {body.occupied.items} item
              {body.occupied.items === 1 ? "" : "s"}. The copy adds to it.
            </dd>
          )}
        </dl>
      );
    case "setting":
      return <p className="text-body">{body.text}</p>;
  }
}

export function SendPreview({
  fields,
  summary,
}: {
  fields: readonly PreviewField[];
  summary: ChangeSummary;
}) {
  // One final outcome for every section says nothing the pane's own status doesn't. Live progress stays, since it changes section by section.
  const labels = new Set(fields.map((field) => fieldChip(field.status, summary)?.label));
  const alike = labels.size === 1 && (labels.has("Landed") || labels.has("Not written"));
  // When part of a write failed, the failure is the news. What landed folds to its heading and chip, and still opens.
  const failed = fields.some((field) => fieldChip(field.status, summary)?.tone === "failed");
  return (
    <>
      {fields.map((field) => {
        const chip = alike ? null : fieldChip(field.status, summary);
        const inline = field.body.kind === "grade";
        const head = (
          <div className="flex min-h-5 flex-1 items-center gap-2">
            <h4 className="flex-1 text-body font-medium text-foreground">{field.label}</h4>
            {inline && <Body body={field.body} />}
            {chip && (
              <Badge data-field-chip tone={CHIP_TONE[chip.tone]} icon={CHIP_ICON[chip.tone]}>
                {chip.tone === "working" && (
                  <span className="dot-pulse size-1 rounded-full bg-current" />
                )}
                {chip.label}
              </Badge>
            )}
          </div>
        );
        const rest = (
          <>
            {!inline && <Body body={field.body} />}
            {field.note && <p className="text-meta text-muted-foreground">{field.note}</p>}
          </>
        );
        return (
          <section
            key={field.field}
            data-field={field.field}
            data-status={field.status}
            className="flex flex-col gap-2 border-b border-border px-card py-3"
          >
            {failed && chip?.tone === "landed" ? (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 flex-none text-muted-foreground transition-transform duration-100 group-open:rotate-90" />
                  {head}
                </summary>
                <div className="mt-2 flex flex-col gap-2">{rest}</div>
              </details>
            ) : (
              <>
                {head}
                {rest}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
