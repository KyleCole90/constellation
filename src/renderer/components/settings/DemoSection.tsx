import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { FIELD_LABEL } from "~/shared/domain/change";
import { isDemoSchool } from "~/shared/domain/lms";
import type { LmsRef, SchoolId } from "~/shared/domain/ids";
import { faultLab, useWorkspace, workspaceStore } from "~/renderer/stores/workspace";

import { SchoolBadge } from "../SchoolBadge";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { STATUS_VIEW, connectionStatus } from "./connection.logic";
import { NOISE_DIALS, dialPatch, dialValue, parseGrade } from "./demo.logic";
import { SettingsCard, SettingsRow, SettingsSection } from "./layout";
import { Picker, type PickerItem } from "./Picker";
import { ResetDemoDialog } from "./ResetDemoDialog";

const PARTIAL_ERROR = { kind: "unavailable", status: 500 } as const;
const THROTTLE_MS = 3000;
const REGRADE_BY = "Jordan Pike (TA)";

const useLab = () => {
  const lab = faultLab();
  useSyncExternalStore(lab.subscribe, lab.version);
  return lab;
};

function NoiseCard() {
  const lab = useLab();
  const noise = lab.noise();
  const [calmFastest, calmSlowest] = lab.defaultNoise().latencyMs;
  return (
    <SettingsCard data-testid="noise-card">
      <SettingsRow
        title="Random failures"
        description={`How rough the fake LMS is on every request. This stays through a reload. Reset to calm turns failures off and answers in ${calmFastest}–${calmSlowest} ms.`}
        control={<Button onClick={() => lab.resetNoise()}>Reset to calm</Button>}
      />
      {NOISE_DIALS.map((dial) => {
        const value = dialValue(noise, dial.key);
        return (
          <label
            key={dial.key}
            className="grid grid-cols-[minmax(0,1fr)_240px_3.5rem] items-center gap-x-3 px-4 py-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-meta">{dial.label}</span>
              <span className="truncate text-meta text-muted-foreground">{dial.words}</span>
            </span>
            <input
              type="range"
              data-dial={dial.key}
              aria-label={dial.label}
              min={0}
              max={dial.max}
              step={dial.step}
              value={value}
              onChange={(event) =>
                lab.setNoise(dialPatch(noise, dial.key, Number(event.target.value)))
              }
              style={{ "--fill": value / dial.max }}
              className="w-full"
            />
            <output
              data-dial-value={dial.key}
              className="text-right text-meta text-secondary-label tabular-nums"
            >
              {value}
              {dial.unit}
            </output>
          </label>
        );
      })}
    </SettingsCard>
  );
}

function DemoScriptRow() {
  const lab = useLab();
  const { enabled, fired } = lab.demoScript();
  return (
    <SettingsRow
      data-testid="demo-script"
      title="Demo script"
      description={`While you grade, a TA regrades a student, one comment fails after its grade lands, and one write gets throttled.${fired.length > 0 ? ` Already happened: ${fired.join(", ")}.` : ""}`}
      control={
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Demo script"
          onClick={() => lab.setDemoScript(!enabled)}
          className={`relative h-[18px] w-[30px] cursor-pointer rounded-full transition-colors ${enabled ? "bg-primary" : "bg-foreground/15"}`}
        >
          <span
            className={`absolute top-[2px] size-[14px] rounded-full bg-white transition-[left] ${enabled ? "left-[14px]" : "left-[2px]"}`}
          />
        </button>
      }
    />
  );
}

function OneShot({
  id,
  title,
  words,
  state,
  children,
}: {
  id: string;
  title: string;
  words: string;
  state?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsRow
      data-fault={id}
      title={
        <>
          {title}
          {state}
        </>
      }
      description={words}
      control={children}
    />
  );
}

const Armed = () => <Badge tone="warning">Armed</Badge>;

function ExpireFault() {
  const allSchools = useWorkspace((state) => state.schools);
  const schools = useMemo(() => allSchools.filter(isDemoSchool), [allSchools]);
  const [school, setSchool] = useState<SchoolId | null>(schools[0]?.id ?? null);
  const status = useWorkspace((state) =>
    school
      ? connectionStatus(state.connections[school], Boolean(state.syncing[school]))
      : "disconnected",
  );
  const expire = () => {
    if (!school) return;
    faultLab().expireToken(school);
    void workspaceStore().getState().syncSchool(school);
  };
  return (
    <OneShot
      id="expire"
      title="Expire a school's token"
      words="The LMS revokes the token now, and the app finds out on a sync straight after. Unsent work and approvals stay. Sends wait until you reconnect."
      state={
        school && (
          <span className="inline-flex items-center gap-1.5">
            <SchoolBadge school={school} />
            <Badge tone={STATUS_VIEW[status].badge} icon={STATUS_VIEW[status].icon}>
              {STATUS_VIEW[status].label}
            </Badge>
          </span>
        )
      }
    >
      <Picker
        label="School to expire"
        items={schools.map((s) => ({ value: s.id, label: s.name }))}
        value={school}
        onChange={(value) => setSchool(value as SchoolId)}
      />
      <Button disabled={status === "expired" || status === "disconnected"} onClick={expire}>
        Expire token
      </Button>
    </OneShot>
  );
}

function RegradeFault() {
  const schools = useWorkspace((state) => state.schools);
  const caches = useWorkspace((state) => state.cache);
  const items = useMemo(
    () =>
      schools.filter(isDemoSchool).flatMap((school) => {
        const cache = caches[school.id];
        if (!cache) return [];
        return cache.submissions
          .filter((submission) => submission.workflow === "submitted")
          .map((submission): PickerItem => ({
            value: submission.ref,
            label: `${submission.studentName}, ${cache.assignments.find((a) => a.ref === submission.assignment)?.shortTitle ?? "assignment"}`,
          }));
      }),
    [schools, caches],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("65");
  const [done, setDone] = useState<string | null>(null);
  const current =
    picked && items.some((item) => item.value === picked) ? picked : (items[0]?.value ?? null);
  const grade = parseGrade(text);
  const change = () => {
    if (!current || grade === null) return;
    faultLab().changeGradeOutOfBand(current as LmsRef<"submission">, grade, REGRADE_BY);
    setDone(`${items.find((item) => item.value === current)?.label} is now ${grade}`);
  };
  return (
    <OneShot
      id="regrade"
      title="Change a grade in the LMS"
      words={`${REGRADE_BY} changes this grade on the LMS now. A draft for that student finds the conflict when you send it.`}
      state={done && <Badge tone="info">{done}</Badge>}
    >
      <Picker label="Submission to change" items={items} value={current} onChange={setPicked} />
      <input
        type="number"
        aria-label="New grade"
        min={0}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="h-btn-md w-14 rounded-control border border-input bg-background px-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button disabled={!current || grade === null} onClick={change}>
        Change grade
      </Button>
    </OneShot>
  );
}

function ArmedFaults() {
  const lab = useLab();
  const armed = lab.armed();
  const partial = armed.failedFields.includes("comment");
  return (
    <>
      <OneShot
        id="partial"
        title="Next write fails partially"
        words="The next grade with a comment lands its grade, and the comment fails with a 500. The app holds it as partly sent."
        state={partial && <Armed />}
      >
        <Button disabled={partial} onClick={() => lab.failNextWrite("comment", PARTIAL_ERROR)}>
          {partial ? "Armed" : "Arm"}
        </Button>
      </OneShot>
      <OneShot
        id="lost"
        title="Lose next response"
        words="The next write lands, but its response never arrives, so the app has to read the LMS to learn what happened."
        state={armed.lostResponses > 0 && <Armed />}
      >
        <Button disabled={armed.lostResponses > 0} onClick={() => lab.loseNextResponse()}>
          {armed.lostResponses > 0 ? "Armed" : "Arm"}
        </Button>
      </OneShot>
      <OneShot
        id="throttle"
        title="Throttle next"
        words={`The next write gets a 429 asking for ${THROTTLE_MS / 1000} seconds. The send waits it out and carries on.`}
        state={armed.throttles > 0 && <Armed />}
      >
        <Button
          disabled={armed.throttles > 0}
          onClick={() => lab.throttleNext(THROTTLE_MS, "write")}
        >
          {armed.throttles > 0 ? "Armed" : "Arm"}
        </Button>
      </OneShot>
    </>
  );
}

const timeOf = (at: string) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function WritesLog() {
  const lab = useLab();
  const writes = [...lab.writes()].reverse();
  return (
    <SettingsSection
      title="Writes that reached the LMS"
      description="Everything the fake LMS accepted, newest first. It only grows after you approve and send, so it's the proof nothing goes through without you."
    >
      <div
        data-testid="writes-log"
        data-count={writes.length}
        className="max-h-64 overflow-y-auto rounded-xl border border-border bg-card"
      >
        {writes.length === 0 ? (
          <p className="px-4 py-3 text-meta text-muted-foreground">Nothing has reached the LMS.</p>
        ) : (
          <table className="w-full text-meta">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground">
              <tr>
                <th className="px-cell-x py-cell-y font-normal">Time</th>
                <th className="px-cell-x py-cell-y font-normal">School</th>
                <th className="px-cell-x py-cell-y font-normal">Target</th>
                <th className="py-cell-y pr-cell-end pl-cell-x font-normal">Fields</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {writes.map((write, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- entries are rendered whole from props and carry no id
                <tr key={`${write.at}-${index}`} data-write>
                  <td className="px-cell-x py-cell-y whitespace-nowrap text-secondary-label tabular-nums">
                    {timeOf(write.at)}
                  </td>
                  <td className="px-cell-x py-cell-y">
                    <SchoolBadge school={write.school} />
                  </td>
                  <td className="px-cell-x py-cell-y">{write.target}</td>
                  <td className="py-cell-y pr-cell-end pl-cell-x text-secondary-label">
                    {write.fields.map((field) => FIELD_LABEL[field]).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SettingsSection>
  );
}

export function DemoSection() {
  const [resetting, setResetting] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Failure lab"
        description="Make the fake LMS misbehave, so you can see how the app holds up. Nothing here touches a real school."
      >
        <NoiseCard />
        <SettingsCard data-testid="one-shots">
          <DemoScriptRow />
          <ExpireFault />
          <RegradeFault />
          <ArmedFaults />
        </SettingsCard>
        <p className="text-meta text-muted-foreground">
          Anything armed fires once on the next matching write. A reload clears what hasn't fired.
        </p>
      </SettingsSection>
      <WritesLog />
      <SettingsSection title="Reset">
        <SettingsCard>
          <SettingsRow
            title="Reset demo data"
            description="Wipes changes, threads, tokens, and the fake LMS, then starts over at the welcome screen."
            control={
              <Button variant="destructive-outline" onClick={() => setResetting(true)}>
                Reset demo data
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>
      <ResetDemoDialog open={resetting} onOpenChange={setResetting} />
    </div>
  );
}
