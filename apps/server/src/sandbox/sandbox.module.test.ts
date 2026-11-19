import { describe, expect, it } from "vitest";
import { parseIdleTimeout } from "./sandbox.module.js";

describe("parseIdleTimeout", () => {
  it("leaves an unset or blank value to the provider default", () => {
    expect(parseIdleTimeout(undefined)).toBeUndefined();
    expect(parseIdleTimeout(" ")).toBeUndefined();
  });

  it("accepts a positive whole number of minutes", () => {
    expect(parseIdleTimeout("15")).toBe(15);
  });

  it.each(["5m", "0", "-3", "2.5"])("rejects %s", (raw) => {
    expect(() => parseIdleTimeout(raw)).toThrow(/positive whole number/);
  });
});
