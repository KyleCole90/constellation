interface Updater {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "update-downloaded", listener: (update: { version: string }) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export const startUpdates = (updater: Updater, ready: (version: string) => Promise<boolean>) => {
  updater.on("error", () => {});
  updater.on("update-downloaded", ({ version }) => {
    ready(version).then(
      (restart) => {
        if (restart) updater.quitAndInstall();
      },
      () => {},
    );
  });
  updater.checkForUpdates().catch(() => {});
};
