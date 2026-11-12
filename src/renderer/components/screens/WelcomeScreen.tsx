import { REAL_AI, VAULT_PLACE } from "~/renderer/desktop";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { Check, Lock } from "lucide-react";
import { useState } from "react";

import mark from "~/renderer/assets/mark.svg";
import type { School } from "~/shared/domain/lms";
import { cn } from "~/renderer/lib/utils";
import type { AiSource } from "~/renderer/stores/types";
import { useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { Brand, PRODUCT_NAME } from "../Brand";
import { isMacDevice } from "../device";
import { AiKeyForm } from "../settings/AiKeyForm";
import {
  AddressField,
  Dot,
  InstitutionList,
  useInstitutions,
  type InstitutionRow,
} from "../settings/Institutions";
import { Button } from "../ui/button";

const NO_MODEL = REAL_AI
  ? "With a key, drafts and chat come from Claude, billed to your Anthropic account."
  : "No model is wired up in this build yet, so AI drafts come from built-in rules for now.";
const PROMISE = "Nothing reaches your LMS until you approve it.";

interface AiOption {
  source: AiSource;
  title: string;
  body(mac: boolean): string;
  needsMac?: true;
}

const AI_OPTIONS: readonly AiOption[] = [
  {
    source: "key",
    title: "Claude, with your Anthropic API key",
    body: () => `The key stays in ${VAULT_PLACE} and is never shown again.`,
  },
  // The desktop app drafts with Claude alone (D27), so it offers no on-device model.
  ...(REAL_AI
    ? []
    : [
        {
          source: "on-device",
          title: "On-device model",
          body: (mac: boolean) =>
            mac
              ? "The model built into macOS. Nothing leaves this Mac."
              : "Only on a Mac with Apple Intelligence.",
          needsMac: true,
        } satisfies AiOption,
      ]),
  {
    source: "none",
    title: "No AI",
    body: () => "You fill in grades and replies by hand. Turn on AI later in Settings.",
  },
];

const AI_WORDS: Readonly<Record<AiSource, string>> = {
  key: "Claude, with your key",
  "on-device": "this Mac",
  none: "off",
};

function Notice() {
  const notice = useWorkspace((state) => state.notice);
  return notice ? (
    <p role="status" className="text-meta text-warning-foreground">
      {notice}
    </p>
  ) : null;
}

export function WelcomeScreen() {
  const navigate = useNavigate();
  const next = useRouterState({ select: (state) => state.location.state.next });
  const setUp = () => {
    workspaceStore().getState().setOnboarding("setup");
    void navigate({ to: "/setup", state: { fromWelcome: true, ...(next && { next }) } });
  };
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-6 px-10">
      <img src={mark} alt="" className="size-12" />
      <h1 className="text-hero">Welcome to {PRODUCT_NAME}</h1>
      <div className="flex max-w-[460px] flex-col gap-2 text-center">
        <p className="text-body text-secondary-label">
          Each school is a star in your academic journey.
        </p>
        <p className="text-body text-secondary-label">
          Grades, replies, and announcements for every course at every school, from one place.
        </p>
        <p className="text-body text-secondary-label">{PROMISE}</p>
      </div>
      <Button variant="default" size="lg" onClick={setUp}>
        Set up
      </Button>
      <Notice />
    </main>
  );
}

function SectionTitle({ number, children }: { number: number; children: string }) {
  return (
    <h2 className="text-page">
      <span className="mr-2 tabular-nums text-muted-foreground">{number}</span>
      {children}
    </h2>
  );
}

function AiChoices({
  choice,
  onChoose,
  disabled,
}: {
  choice: AiSource | null;
  onChoose: (source: AiSource) => void;
  disabled: boolean;
}) {
  const keySaved = useWorkspace((state) => state.aiSource === "key");
  const mac = isMacDevice();
  return (
    <fieldset disabled={disabled} data-testid="ai-choices" className="flex flex-col gap-3">
      <legend className="contents">
        <SectionTitle number={2}>AI</SectionTitle>
      </legend>
      <p className="flex items-center gap-1.5 text-meta text-muted-foreground">
        {disabled && <Lock aria-hidden className="size-3 flex-none" />}
        {disabled ? "Connect a school first." : NO_MODEL}
      </p>
      <div
        className={cn(
          "flex flex-col divide-y divide-border rounded-xl border border-border bg-card",
          disabled && "text-muted-foreground",
        )}
      >
        {AI_OPTIONS.map((option) => {
          const unavailable = option.needsMac === true && !mac;
          // Tertiary text instead of opacity, so an option you can't pick yet reads as off and still clears 4.5:1.
          const off = unavailable && !disabled;
          return (
            <div
              key={option.source}
              data-ai-source={option.source}
              className="flex flex-col gap-2 px-card py-3"
            >
              <label
                className={cn(
                  "flex items-start gap-3",
                  off || disabled ? "cursor-not-allowed" : "cursor-pointer",
                )}
              >
                <input
                  type="radio"
                  name="ai-source"
                  value={option.source}
                  className="mt-1 accent-primary disabled:opacity-40"
                  disabled={unavailable}
                  checked={choice === option.source}
                  onChange={() => onChoose(option.source)}
                />
                <span className="flex flex-col">
                  <span className={cn("text-title", off && "text-tertiary-label")}>
                    {option.title}
                  </span>
                  <span
                    className={cn(
                      "text-meta",
                      off ? "text-tertiary-label" : !disabled && "text-muted-foreground",
                    )}
                  >
                    {option.body(mac)}
                  </span>
                </span>
              </label>
              {option.source === "key" &&
                choice === "key" &&
                (keySaved ? (
                  <p className="flex items-center gap-1.5 pl-7 text-meta text-success-foreground">
                    <Check className="size-3" />
                    Key saved
                  </p>
                ) : (
                  <div className="pl-7">
                    <AiKeyForm layout="inline" submitLabel="Save key" />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function SummaryRow({ row }: { row: InstitutionRow }) {
  const connected = useWorkspace((state) =>
    row.school ? state.connections[row.school.id]?.status === "connected" : false,
  );
  const courses = useWorkspace((state) =>
    row.school ? (state.cache[row.school.id]?.courses.length ?? 0) : 0,
  );
  const school: School | null = connected ? row.school : null;
  return (
    <li className="flex min-w-0 items-start gap-2 text-body">
      <span className="flex h-5 flex-none items-center">
        <Dot school={school} />
      </span>
      <span className={cn("min-w-0 break-words", !school && "text-muted-foreground")}>
        {school ? `${school.name}, ${courses} ${courses === 1 ? "course" : "courses"}` : row.host}
      </span>
    </li>
  );
}

export function SetupScreen() {
  const navigate = useNavigate();
  const router = useRouter();
  const institutions = useInstitutions({ includeSaved: true, draftsKey: "setup.drafts" });
  const enrollment = useWorkspace((state) => state.newSchoolEnrollment());
  const demo = useWorkspace((state) => state.demoHosts().length > 0);
  const connected = useWorkspace(
    (state) =>
      state.schools.filter((school) => state.connections[school.id]?.status === "connected").length,
  );
  // What's due is built from each school's first read, so finishing before it lands shows a partial plan that keeps changing.
  const reading = useWorkspace((state) =>
    state.schools
      .filter(
        (school) => state.syncing[school.id] && state.connections[school.id]?.lastSyncedAt === null,
      )
      .map((school) => school.name)
      .join(" and "),
  );
  const keySaved = useWorkspace((state) => state.aiSource === "key");
  const [choice, setChoice] = useState<AiSource | null>(() => {
    const saved = workspaceStore().getState().aiSource;
    return saved === "none" ? null : saved;
  });
  const blocker =
    connected === 0
      ? "Connect a school to finish."
      : choice === null
        ? "Choose an AI option to finish."
        : choice === "key" && !keySaved
          ? "Save your key to finish."
          : reading
            ? `Reading courses from ${reading}…`
            : null;

  const finish = async () => {
    const store = workspaceStore().getState();
    if (choice === "on-device") await store.chooseOnDeviceModel();
    if (choice === "none") await store.turnOffAi();
    store.setOnboarding("done");
    store.dismissNotice();
    // Stepping back onto the welcome entry lets the gate replace it with the app, so Back from the app skips welcome and setup.
    if (router.state.location.state.fromWelcome) router.history.back();
    else void navigate({ href: router.state.location.state.next ?? "/", replace: true });
  };

  const placeholder =
    enrollment?.kind === "paste-token"
      ? `Type the address you sign in at, like ${enrollment.addressPlaceholder}`
      : "Type the address you sign in at";

  return (
    <main className="h-dvh overflow-y-auto px-10 pt-12">
      {/* One centred column at every width. The summary sits just above Finish setup, so the check before finishing is never far from the button. */}
      <div className="mx-auto flex w-full max-w-setup flex-col gap-6">
        <div className="flex flex-col gap-8">
          <Brand />
          <Notice />

          <section data-testid="where-you-teach" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-4">
              <SectionTitle number={1}>Where you teach</SectionTitle>
              {demo && (
                <Button
                  variant="link"
                  size="sm"
                  className="-mr-2.5"
                  onClick={institutions.fillDemo}
                >
                  Use demo institutions and tokens
                </Button>
              )}
            </div>
            <AddressField institutions={institutions} placeholder={placeholder} autoFocus />
            <InstitutionList institutions={institutions} />
            {institutions.rows.length === 0 && (
              <p className="text-meta text-muted-foreground">
                Add the address you sign in at for each school. We link you straight to its token
                page.
              </p>
            )}
          </section>

          <AiChoices choice={choice} onChoose={setChoice} disabled={connected === 0} />
        </div>

        <aside
          data-testid="constellation-summary"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-card"
        >
          <h2 className="text-title text-foreground">Your constellation</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {institutions.rows.length === 0 && (
              <li className="text-meta text-muted-foreground">No institutions yet.</li>
            )}
            {institutions.rows.map((row) => (
              <SummaryRow key={row.host} row={row} />
            ))}
          </ul>
          <span className="text-meta text-muted-foreground">
            AI:{" "}
            {choice === null
              ? "not chosen"
              : choice === "key" && !keySaved
                ? "key needed"
                : AI_WORDS[choice]}
          </span>
        </aside>

        {/* Pinned to the bottom of the scroll, so Finish and why it waits stay on screen however long the list gets. */}
        <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-background py-4">
          <span id="finish-reason" className="text-meta text-muted-foreground">
            {blocker ?? PROMISE}
          </span>
          <Button
            variant="default"
            size="lg"
            disabled={blocker !== null}
            aria-describedby="finish-reason"
            onClick={() => void finish()}
          >
            Finish setup
          </Button>
        </div>
      </div>
    </main>
  );
}
