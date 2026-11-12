import { desktopBridge } from "~/renderer/desktop";
import { useEffect, useState } from "react";

import privacy from "../../../../PRIVACY.md?raw";
import { SettingsCard, SettingsRow, SettingsSection } from "./layout";

/** PRIVACY.md as headings and paragraphs, with its bold and code marks dropped. */
const PRIVACY_BLOCKS = privacy
  .split(/\n{2,}/)
  .map((block) => block.trim().replaceAll("**", "").replaceAll("`", ""))
  .filter((block) => block !== "");

export function PrivacyNotice() {
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

/** The crash-report choice main keeps. Null until main answers, and always in the web demo, which sends nothing. */
const useCrashReports = () => {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    void desktopBridge?.invoke("telemetry.status", undefined).then(setStatus);
  }, []);
  const choose = (enabled: boolean) => {
    if (!desktopBridge || !status) return;
    setStatus({ ...status, enabled });
    void desktopBridge.invoke("telemetry.choose", { enabled });
  };
  return { status, choose };
};

/** The opt-out, on by default (D24). Hidden in the web demo, which has nothing to turn off. */
export function CrashReportsToggle() {
  const { status, choose } = useCrashReports();
  if (!status) return null;
  return (
    <label data-testid="crash-reports" className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 accent-primary"
        checked={status.enabled}
        onChange={(event) => choose(event.target.checked)}
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
