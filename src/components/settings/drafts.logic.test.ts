import { describe, expect, it } from "vite-plus/test";

import { placeRows, readDraftHosts } from "./drafts.logic";

describe("kept setup addresses", () => {
  it("come back as the addresses that were typed", () => {
    const kept = JSON.stringify(["lakeshore.instructure.com", "riverbend.instructure.com"]);
    expect(readDraftHosts(kept)).toEqual([
      "lakeshore.instructure.com",
      "riverbend.instructure.com",
    ]);
  });

  it("read as none when nothing was kept or the entry is damaged", () => {
    expect(readDraftHosts(null)).toEqual([]);
    expect(readDraftHosts("{not json")).toEqual([]);
    expect(readDraftHosts(JSON.stringify({ host: "lakeshore.instructure.com" }))).toEqual([]);
  });

  it("drop anything that isn't an address, and repeats", () => {
    const kept = JSON.stringify([
      "harvard",
      7,
      "Lakeshore.instructure.com",
      "lakeshore.instructure.com",
    ]);
    expect(readDraftHosts(kept)).toEqual(["lakeshore.instructure.com"]);
  });
});

describe("setup rows", () => {
  it("keep their places when a later row's school connects and is listed first", () => {
    const placed = ["lakeshore", "riverbend"];
    const listed = [{ key: "riverbend" }, { key: "lakeshore" }];
    expect(placeRows(listed, placed).map((row) => row.key)).toEqual(["lakeshore", "riverbend"]);
  });

  it("put a row not placed yet last", () => {
    const listed = [{ key: "new" }, { key: "lakeshore" }];
    expect(placeRows(listed, ["lakeshore"]).map((row) => row.key)).toEqual(["lakeshore", "new"]);
  });
});
