import { Check } from "lucide-react";
import { useState } from "react";

import type { ChangeRecord } from "~/domain/change";
import type { LmsRef } from "~/domain/ids";
import { STEPS, stepOf, type SetupStage } from "~/domain/setup";
import { cn } from "~/lib/utils";
import { selectSetupView } from "~/stores/selectors";
import type { Thread } from "~/stores/types";
import { useWorkspace } from "~/stores/workspace";

import { CopyDates, DatesCard } from "./DatesCard";
import { Card, Note } from "./parts";
import { Readiness } from "./Readiness";
import { ReviewCard } from "./ReviewCard";
import { SaveTemplateButton } from "./SaveTemplateButton";
import { CopyFailed, CopyProgress } from "./ScanCards";
import { SetupChangeCard } from "./SetupChangeCard";
import { publishedWords } from "./setup.logic";
import { SourceCard } from "./SourceCard";

/** Undefined outside a setup thread. Otherwise what the chat follows to the bottom on. */
export const useSetupStep = (thread: Thread): string | undefined =>
  useWorkspace((state) =>
    thread.kind === "setup" && thread.course
      ? (selectSetupView(state, thread.course).stage?.tag ?? "template")
      : undefined,
  );

/** Once published, End of term waits for the term to end, so no step is current. */
const railState = (step: number, stage: SetupStage): "complete" | "current" | "upcoming" => {
  const current = stepOf(stage);
  if (step === 1 || step < current) return "complete";
  return step === current && stage.tag !== "published" ? "current" : "upcoming";
};

export function SetupRail({ thread }: { thread: Thread }) {
  const stage = useWorkspace((state) =>
    thread.course ? selectSetupView(state, thread.course).stage : null,
  );
  if (!stage) return null;
  return (
    <ol
      data-testid="setup-rail"
      aria-label="Setup steps"
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-4 py-1.5"
    >
      {STEPS.map((name, index) => {
        const step = index + 1;
        const state = railState(step, stage);
        return (
          <li
            key={name}
            data-testid={`setup-step-${step}`}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-1 text-meta",
              state === "current" ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {state === "complete" ? (
              <Check className="size-3 text-success-foreground/70" />
            ) : (
              <span className="tabular-nums text-meta">{step}</span>
            )}
            {name}
          </li>
        );
      })}
    </ol>
  );
}

function TemplatePart({
  course,
  template,
}: {
  course: LmsRef<"course">;
  template: ChangeRecord | null;
}) {
  if (!template) return <SaveTemplateButton course={course} variant="default" />;
  return (
    <SetupChangeCard id={template.id} name="template" sendLabel={(vendor) => `Send to ${vendor}`} />
  );
}

function ReviewStage({
  course,
  thread,
  stage,
}: {
  course: LmsRef<"course">;
  thread: Thread;
  stage: Extract<SetupStage, { tag: "review" | "publish-check" }>;
}) {
  const view = useWorkspace((state) => selectSetupView(state, course));
  const [opened, setOpened] = useState<string | null>(null);
  if (!view.setup) return null;
  const openRow = (key: string) => {
    setOpened(key);
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-finding-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  };
  return (
    <>
      <ReviewCard
        course={course}
        school={view.setup.school}
        thread={thread.id}
        rows={view.rows}
        opened={opened}
        onOpen={setOpened}
      />
      <Readiness
        course={course}
        setup={view.setup}
        rows={view.rows}
        publish={stage.tag === "publish-check" ? stage.publish : null}
        ready={view.readiness.ready}
        onOpenRow={openRow}
      />
    </>
  );
}

function Stage({ thread }: { thread: Thread }) {
  const course = thread.course;
  const view = useWorkspace((state) => (course ? selectSetupView(state, course) : null));
  if (!course || !view) return null;
  const { setup, stage, live, template } = view;
  if (!setup || !stage) return <TemplatePart course={course} template={template} />;
  switch (stage.tag) {
    case "source":
      return <SourceCard setup={setup} />;
    case "dates":
      return <DatesCard setup={setup} />;
    case "approve-copy":
      return (
        <>
          <DatesCard setup={setup} confirmed />
          <SetupChangeCard
            id={stage.copy}
            name="copy"
            sendLabel={(vendor) => `Send to ${vendor}`}
            stale={stage.stale ? "The dates changed. Review the copy again to approve it." : null}
          >
            <CopyDates setup={setup} />
          </SetupChangeCard>
        </>
      );
    case "copying":
    case "scanning":
      return <CopyProgress course={course} job={stage.job} live={live} />;
    case "copy-failed":
      return <CopyFailed course={course} migration={stage.migration} />;
    case "review":
    case "publish-check":
      return <ReviewStage course={course} thread={thread} stage={stage} />;
    case "published":
      return (
        <>
          <Card title={`${setup.shell.code} is published`} testId="published-card">
            <Note>
              Students can see it now. {publishedWords(view.rows)} At the end of the term, save it
              as a template from its course page, and it will list as a source for the next one.
            </Note>
          </Card>
          {template && <TemplatePart course={course} template={template} />}
        </>
      );
  }
}

/** What the thread shows under its chat. The stage alone decides, so a reload lands on the same screen. */
export function SetupScreen({ thread }: { thread: Thread }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <Stage thread={thread} />
    </div>
  );
}
