import { useDesktopBridge } from "~/renderer/desktop";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { Bridge } from "~/shared/ipc";

import privacy from "../../../../PRIVACY.md?raw";
import { SettingsCard, SettingsRow, SettingsSection } from "./layout";

/** PRIVACY.md as headings and paragraphs, with its bold and code marks dropped. */
const PRIVACY_BLOCKS = privacy
  .split(/\n{2,}/)
  .map((block) => block.trim().replaceAll("**", "").replaceAll("`", ""))
  .filter((block) => block !== "");

function PrivacyNotice() {
  return (
    <div data-testid="privacy-notice" className="flex max-w-[72ch] flex-col gap-2 text-meta">
      {PRIVACY_BLOCKS.slice(1).map((block) =>
        block.startsWith("## ") ? (
          <h3 key={block} className="pt-1 text-body font-medium">
            {block.slice(3)}
          </h3>
        ) : (
          <p key={block} className="whitespace-pre-line text-muted-foreground">
            {block}
          </p>
        ),
      )}
    </div>
  );
}

interface Status {
  readonly enabled: boolean;
  readonly available: boolean;
}

/**
 * The usage-data and crash-report choice main keeps, which the setup page and Settings both show and change. Null
 * until main answers, and always in the web demo, which sends nothing.
 */
const createTelemetryChoice = (bridge: Bridge) => {
  let status: Status | null = null;
  const listeners = new Set<() => void>();
  const set = (next: Status) => {
    status = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: async () => {
      set(await bridge.invoke("telemetry.status", undefined));
    },
    choose: async (enabled: boolean) => {
      if (!status) return;
      set({ ...status, enabled });
      await bridge.invoke("telemetry.choose", { enabled });
    },
  };
};

const choices = new WeakMap<Bridge, ReturnType<typeof createTelemetryChoice>>();

export const telemetryChoiceFor = (bridge: Bridge) => {
  let choice = choices.get(bridge);
  if (!choice) {
    choice = createTelemetryChoice(bridge);
    choices.set(bridge, choice);
  }
  return choice;
};

const noopSubscribe = () => () => {};
const noStatus = (): Status | null => null;

const useTelemetryChoice = () => {
  const bridge = useDesktopBridge();
  const choice = bridge ? telemetryChoiceFor(bridge) : null;
  const status = useSyncExternalStore(
    choice ? choice.subscribe : noopSubscribe,
    choice ? choice.get : noStatus,
    choice ? choice.get : noStatus,
  );
  useEffect(() => {
    void choice?.load();
  }, [choice]);
  return { choice, status };
};

/**
 * The one opt-out, on by default. A copy of the app that can't send (no build key, not packaged, or turned off in its
 * environment) says so instead of offering a choice that does nothing. Hidden in the web demo, which has nothing to turn off.
 */
function TelemetryToggle() {
  const { choice, status } = useTelemetryChoice();
  if (!choice || !status) return null;
  if (!status.available)
    return (
      <p data-testid="usage-data" className="text-meta text-muted-foreground">
        Usage data and crash reports are off in this copy of the app, so nothing is sent.
      </p>
    );
  return (
    <label data-testid="usage-data" className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 size-3.5 flex-none accent-primary"
        checked={status.enabled}
        onChange={(event) => void choice.choose(event.target.checked)}
      />
      <span className="flex flex-col">
        <span className="text-body font-medium">Send usage data and crash reports</span>
        <span className="text-meta text-muted-foreground">
          Which parts of the app you use, and for an error, its type and where in the app's code it
          happened. Never student data or anything you typed. The privacy notice lists exactly what
          is sent.
        </span>
      </span>
    </label>
  );
}

/** The setup page's privacy step: the opt-out, then the whole notice behind a disclosure. */
export function SetupPrivacy({ title }: { title: ReactNode }) {
  const bridge = useDesktopBridge();
  const sends = useTelemetryChoice().status?.available === true;
  return (
    <section data-testid="setup-privacy" className="flex flex-col gap-3">
      {title}
      <p className="text-meta text-muted-foreground">
        {!bridge
          ? "This web demo sends nothing anywhere."
          : sends
            ? "There is no Constellation server. Only your school, Anthropic (with your key or through your Claude Code), and PostHog, for usage data and scrubbed crash reports, hear from this Mac. Constellation never asks for, sees or stores your Claude login."
            : "There is no Constellation server. Only your school, and Anthropic if you add a key or use Claude Code, hear from this Mac. Constellation never asks for, sees or stores your Claude login."}
      </p>
      <TelemetryToggle />
      <details className="rounded-xl border border-border bg-card px-card py-3">
        <summary className="cursor-pointer text-body">Read the privacy notice</summary>
        <div className="pt-3">
          <PrivacyNotice />
        </div>
      </details>
    </section>
  );
}

export function PrivacySection() {
  const bridge = useDesktopBridge();
  return (
    <SettingsSection
      title="Privacy"
      description={
        bridge
          ? "There is no Constellation server. Here is everything that leaves this Mac."
          : "This web demo sends nothing anywhere. Here is what the desktop app sends."
      }
    >
      <SettingsCard data-testid="privacy-card">
        {bridge && (
          <SettingsRow title="Usage data and crash reports">
            <TelemetryToggle />
          </SettingsRow>
        )}
        <SettingsRow title="The full notice">
          <PrivacyNotice />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
