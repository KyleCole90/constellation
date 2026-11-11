/** Read at the UI edge. The on-device model ships with macOS, so only a Mac can offer it. */
export const isMacDevice = (): boolean => {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac/i.test(platform);
};
