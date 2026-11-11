import { describe, expect, it } from "vite-plus/test";

import type { ThreadId } from "~/domain/ids";

import { pendingAfterResume, pendingAfterSettle, toastBottomOver } from "./settle.logic";

const a = "a" as ThreadId;
const b = "b" as ThreadId;
const c = "c" as ThreadId;

describe("the settle Undo", () => {
  it("covers every settle made while the toast is up", () => {
    expect(pendingAfterSettle(pendingAfterSettle([], [a]), [b, c])).toEqual([a, b, c]);
  });

  it("lists a thread settled twice once", () => {
    expect(pendingAfterSettle([a], [a])).toEqual([a]);
  });

  it("drops a thread resumed from its row and keeps the rest", () => {
    expect(pendingAfterResume([a, b], [a])).toEqual([b]);
  });
});

describe("toastBottomOver", () => {
  const composer = { top: 800, bottom: 890, left: 480, right: 1248 };

  it("lifts a toast that would cover the composer to just above it", () => {
    expect(toastBottomOver({ top: 844, bottom: 884, left: 1080, right: 1424 }, composer, 900)).toBe(
      108,
    );
  });

  it("leaves the toast alone when it clears the composer or there is none", () => {
    const clear = { top: 844, bottom: 884, left: 1260, right: 1424 };
    expect(toastBottomOver(clear, composer, 900)).toBeNull();
    expect(toastBottomOver(clear, null, 900)).toBeNull();
  });
});
