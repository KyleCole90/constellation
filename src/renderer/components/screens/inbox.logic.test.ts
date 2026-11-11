import { describe, expect, it } from "vite-plus/test";

import { followInboxUrl, parseInboxSearch } from "./inbox.logic";

describe("parseInboxSearch", () => {
  it("keeps a named conversation and drops anything else", () => {
    expect(parseInboxSearch({ conversation: "conv-1" })).toEqual({ conversation: "conv-1" });
    expect(parseInboxSearch({ conversation: "" })).toEqual({});
    expect(parseInboxSearch({ conversation: 4 })).toEqual({});
  });
});

describe("followInboxUrl", () => {
  it("does nothing while the URL names what is open", () => {
    expect(followInboxUrl(true, "conv-1", "conv-1")).toBeNull();
    expect(followInboxUrl(false, undefined, null)).toBeNull();
  });
  it("arriving at a bare Messages writes the open conversation into the URL", () => {
    expect(followInboxUrl(true, undefined, "conv-1")).toEqual({ write: "conv-1" });
  });
  it("Back to an earlier conversation opens it", () => {
    expect(followInboxUrl(false, "conv-1", "conv-2")).toEqual({ open: "conv-1" });
  });
  it("Back to before one was open closes it", () => {
    expect(followInboxUrl(false, undefined, "conv-2")).toEqual({ open: null });
  });
  it("a link that names a conversation opens it", () => {
    expect(followInboxUrl(true, "conv-1", null)).toEqual({ open: "conv-1" });
  });
});
