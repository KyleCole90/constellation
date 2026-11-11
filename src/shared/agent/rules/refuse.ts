export const OUT_OF_SCOPE =
  "I can't approve or send for you. Open a draft, choose Review before sending, and approve it there.";

export const asksToAct = (request: string): boolean =>
  /^\s*(please\s+)?(approve|send|post|submit)\b|\b(approve|send|post|submit)\s+(it|this|that|them|all|these)\b/i.test(
    request,
  );
