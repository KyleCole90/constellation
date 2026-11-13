export const OUT_OF_SCOPE =
  "I can't approve or send for you. Press Approve on the draft, then Send.";

export const asksToAct = (request: string): boolean =>
  /^\s*(please\s+)?(approve|send|post|submit)\b|\b(approve|send|post|submit)\s+(it|this|that|them|all|these)\b/i.test(
    request,
  );
