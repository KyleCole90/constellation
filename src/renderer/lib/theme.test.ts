import { describe, expect, it } from "vite-plus/test";

import { themeAfterKey } from "./theme";

describe("themeAfterKey", () => {
  it("moves the choice along System, Light, Dark with the arrow keys and wraps at the ends", () => {
    expect(themeAfterKey("system", "ArrowRight")).toBe("light");
    expect(themeAfterKey("light", "ArrowDown")).toBe("dark");
    expect(themeAfterKey("dark", "ArrowRight")).toBe("system");
    expect(themeAfterKey("system", "ArrowLeft")).toBe("dark");
    expect(themeAfterKey("light", "ArrowUp")).toBe("system");
  });

  it("leaves the choice alone for any other key", () => {
    expect(themeAfterKey("light", "Enter")).toBeNull();
    expect(themeAfterKey("light", "Tab")).toBeNull();
  });
});
