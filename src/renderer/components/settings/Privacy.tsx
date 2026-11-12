import { desktopBridge } from "~/renderer/desktop";
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
 * The crash-report choice main keeps, which the setup page and Settings both show and change. Null until main
 * answers, and always in the web demo, which sends nothing.
 */
const createCrashReports = (bridge: Bridge | undefined) => {
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
      if (bridge) set(await bridge.invoke("telemetry.status", undefined));
    },
    choose: async (enabled: boolean) => {
      if (!bridge || !status) return;
      set({ ...status, enabled });
      await bridge.invoke("telemetry.choose", { enabled });
    },
  };
};

export const crashReports = createCrashReports(desktopBridge);

/** The opt-out, on by default (D24). Hidden in the web demo, which has nothing to turn off. */
function CrashReportsToggle() {
  const status = useSyncExternalStore(crashReports.subscribe, crashReports.get, crashReports.get);
  useEffect(() => void crashReports.load(), []);
  if (!status) return null;
  return (
    <label data-testid="crash-reports" className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 accent-primary"
        checked={status.enabled}
        onChange={(event) => void crashReports.choose(event.target.checked)}
      />
      <span className="flex flex-col">
        <span className="text-body font-medium">Send crash reports</span>
        <span className="text-meta text-muted-foreground">
          {status.available
            ? "Only an error's type and where in the app's code it happened, the app version and the macOS version. Never its message or anything you typed."
            : "This build of the app sends no reports, whatever you choose here."}
        </span>
      </span>
    </label>
  );
}

/** The setup page's privacy step: the opt-out, then the whole notice behind a disclosure (D24, D36). */
export function SetupPrivacy({ title }: { title: ReactNode }) {
  return (
    <section data-testid="setup-privacy" className="flex flex-col gap-3">
      {title}
      <p className="text-meta text-muted-foreground">
        {desktopBridge
          ? "There is no Constellation server. Only your school, Anthropic with your key, and scrubbed crash reports hear from this Mac."
          : "This web demo sends nothing anywhere."}
      </p>
      <CrashReportsToggle />
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
  return (
    <SettingsSection
      title="Privacy"
      description={
        desktopBridge
          ? "There is no Constellation server. Here is everything that leaves this Mac."
          : "This web demo sends nothing anywhere. Here is what the desktop app sends."
      }
    >
      <SettingsCard data-testid="privacy-card">
        {desktopBridge && (
          <SettingsRow title="Crash reports">
            <CrashReportsToggle />
          </SettingsRow>
        )}
        <SettingsRow title="The full notice">
          <PrivacyNotice />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
