import { describe, expect, it } from "vitest";
import { scrubSecretValues } from "../../executor/redact.js";

describe("scrubSecretValues", () => {
  it("replaces an exact occurrence of a secret value anywhere in the text", () => {
    expect(scrubSecretValues("Invalid password: local-dev-only", ["local-dev-only"])).toBe(
      "Invalid password: [REDACTED:secret]",
    );
  });

  it("replaces a secret value found in a place the caller never anticipated (e.g. an echoed URL)", () => {
    expect(scrubSecretValues("redirected to /reset?token=local-dev-only", ["local-dev-only"])).toBe(
      "redirected to /reset?token=[REDACTED:secret]",
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(scrubSecretValues("local-dev-only appears twice: local-dev-only", ["local-dev-only"])).toBe(
      "[REDACTED:secret] appears twice: [REDACTED:secret]",
    );
  });

  it("scrubs multiple distinct secret values in one pass", () => {
    expect(scrubSecretValues("user=teller pass=local-dev-only", ["teller", "local-dev-only"])).toBe(
      "user=[REDACTED:secret] pass=[REDACTED:secret]",
    );
  });

  it("leaves text unchanged when none of the secret values appear", () => {
    expect(scrubSecretValues("Member: Elena Cho", ["local-dev-only"])).toBe("Member: Elena Cho");
  });

  it("skips an empty-string secret value rather than matching everywhere", () => {
    expect(scrubSecretValues("Member: Elena Cho", [""])).toBe("Member: Elena Cho");
  });

  it("returns the text unchanged when no secret values are given", () => {
    expect(scrubSecretValues("Member: Elena Cho", [])).toBe("Member: Elena Cho");
  });
});
