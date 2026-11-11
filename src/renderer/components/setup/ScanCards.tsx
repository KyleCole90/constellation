import { useState } from "react";

import type { Migration } from "~/shared/domain/content";
import type { LmsRef } from "~/shared/domain/ids";
import type { JobView, SetupLive } from "~/shared/domain/setup";
import { workspaceStore } from "~/renderer/stores/workspace";

import { Button } from "../ui/button";
import { Card, Note, Refusal } from "./parts";

export function CopyProgress({
  course,
  job,
  live,
}: {
  course: LmsRef<"course">;
  job: JobView;
  live: SetupLive | null;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const stuck = live?.scan?.message ?? null;
  return (
    <Card title={job.label} testId="copy-progress">
      {job.completion !== null && (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-valuenow={job.completion}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/7"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${job.completion}%` }}
            />
          </div>
          <span data-testid="copy-percent" className="text-meta text-muted-foreground tabular-nums">
            {job.completion}%
          </span>
        </div>
      )}
      {job.message && <Note>{job.message}</Note>}
      {stuck && (
        <div className="flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-meta text-warning-foreground">
            {stuck}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="scan-again"
            onClick={() => void workspaceStore().getState().scanNow(course).then(setRefused)}
          >
            Scan again
          </Button>
        </div>
      )}
      <Refusal text={refused} />
    </Card>
  );
}

export function CopyFailed({
  course,
  migration,
}: {
  course: LmsRef<"course">;
  migration: Migration;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <Card
      title="The copy failed"
      testId="copy-failed"
      footer={
        <>
          <Button
            variant="outline"
            size="lg"
            data-testid="copy-change-source"
            onClick={() => setRefused(workspaceStore().getState().chooseSource(course, null))}
          >
            Choose another source
          </Button>
          <Button
            variant="default"
            size="lg"
            data-testid="copy-again"
            onClick={() => void workspaceStore().getState().retryCopy(course).then(setRefused)}
          >
            Copy again
          </Button>
        </>
      }
    >
      {migration.message && <p className="text-body">{migration.message}</p>}
      {migration.issues.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-meta text-muted-foreground">
          {migration.issues.map((issue) => (
            <li key={issue.text}>{issue.text}</li>
          ))}
        </ul>
      )}
      <Note>
        Copying again makes a new draft, which needs your approval before anything is sent.
      </Note>
      <Refusal text={refused} />
    </Card>
  );
}
