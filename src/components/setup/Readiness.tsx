import { useState } from "react";

import type { ChangeId, LmsRef } from "~/domain/ids";
import type { CourseSetup, ReviewRow } from "~/domain/setup";
import { formatTime } from "~/lib/utils";
import { workspaceStore } from "~/stores/workspace";

import { Button } from "../ui/button";
import { Card, Refusal } from "./parts";
import { namedRows, readinessTable } from "./setup.logic";
import { SetupChangeCard } from "./SetupChangeCard";

function Table({
  rows,
  onOpenRow,
}: {
  rows: readonly ReviewRow[];
  onOpenRow: (key: string) => void;
}) {
  return (
    <table data-testid="readiness" className="w-full text-left text-meta">
      <tbody>
        {readinessTable(rows).map(({ group, label, left }) => (
          <tr
            key={group}
            data-group={group}
            data-passed={left.length === 0}
            className="border-t border-border align-top first:border-t-0"
          >
            <td className="w-[180px] py-cell-y pr-cell-x">{label}</td>
            <td className="py-cell-y">
              {left.length === 0 ? (
                <span className="text-success-foreground">Pass</span>
              ) : (
                <span className="flex flex-wrap gap-x-2">
                  {namedRows(left).map(({ name, count, first }) => (
                    <button
                      key={name}
                      type="button"
                      data-text-link
                      onClick={() => onOpenRow(first.key)}
                      className="cursor-pointer text-warning-foreground underline underline-offset-2"
                    >
                      {count > 1 ? `${name} (${count})` : name}
                    </button>
                  ))}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Readiness({
  course,
  setup,
  rows,
  publish,
  ready,
  onOpenRow,
}: {
  course: LmsRef<"course">;
  setup: CourseSetup;
  rows: readonly ReviewRow[];
  publish: ChangeId | null;
  ready: boolean;
  onOpenRow: (key: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setRefused(await work());
    setBusy(false);
  };
  const store = () => workspaceStore().getState();
  const check = () =>
    run(() => store().runPublishCheck(course)).then(() => {
      requestAnimationFrame(() =>
        document.querySelector('[data-testid="readiness"]')?.scrollIntoView({ block: "center" }),
      );
    });
  const prepare = () =>
    run(async () => {
      const proposed = await store().proposePublish(course);
      return proposed.ok ? null : proposed.error;
    });
  return (
    <>
      <Card
        title="Publish check"
        footer={
          <>
            {setup.check && (
              <span className="min-w-0 flex-1 text-meta text-muted-foreground">
                Last checked at {formatTime(setup.check.at)}.
              </span>
            )}
            <Button
              size="lg"
              variant={ready && setup.check ? "outline" : "default"}
              data-testid="run-check"
              disabled={busy}
              onClick={() => void check()}
            >
              Run publish check
            </Button>
            {ready && setup.check && !publish && (
              <Button
                variant="default"
                size="lg"
                data-testid="prepare-publish"
                disabled={busy}
                onClick={() => void prepare()}
              >
                Prepare to publish
              </Button>
            )}
          </>
        }
      >
        {setup.check ? (
          <Table rows={rows} onOpenRow={onOpenRow} />
        ) : (
          <p className="text-meta text-muted-foreground">
            Reads the course again and says what is left before students can see it.
          </p>
        )}
        <Refusal text={refused} />
      </Card>
      {publish && (
        <SetupChangeCard id={publish} name="publish" sendLabel={() => "Publish course"} />
      )}
    </>
  );
}
