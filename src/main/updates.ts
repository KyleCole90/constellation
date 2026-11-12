/** The part of electron-updater's `autoUpdater` this file uses, so a test can stand in for it. */
interface Updater {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "update-downloaded", listener: (update: { version: string }) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/**
 * Checks GitHub Releases once, at launch. electron-updater's defaults download a newer release in the background and
 * install it when the app quits. When the download finishes, `ready` tells the teacher, and the app restarts only if
 * they ask it to, so an update never interrupts a send.
 */
export const startUpdates = (updater: Updater, ready: (version: string) => Promise<boolean>) => {
  // Offline, or no release yet: the next launch checks again. Error tracking (step 9) will report these.
  updater.on("error", () => {});
  updater.on("update-downloaded", ({ version }) => {
    ready(version).then(
      (restart) => {
        if (restart) updater.quitAndInstall();
      },
      // The sheet failed to show: the update still installs on quit.
      () => {},
    );
  });
  updater.checkForUpdates().catch(() => {});
};
