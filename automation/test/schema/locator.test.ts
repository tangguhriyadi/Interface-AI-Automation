import { describe, expect, it } from "vitest";
import { LocatorChainSchema, LocatorStrategySchema } from "../../schema/locator.js";

describe("LocatorStrategySchema", () => {
  it("accepts a role+name strategy", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "role",
      role: "button",
      name: "Log In",
      rationale: "The button has a stable accessible name.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a label strategy", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "label",
      text: "Member ID",
      rationale: "The input is associated with this label via for=.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a structural strategy", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "structural",
      description: "cell in the row whose row header matches",
      rowHeader: "Savings",
      rationale: "The value cell has no distinguishing accessible name of its own.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a css strategy missing brittle: true", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "css",
      selector: "#savings-balance",
      rationale: "Last resort.",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a css strategy with brittle: true", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "css",
      selector: "#savings-balance",
      brittle: true,
      rationale: "Last resort.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an xpath strategy with brittle: false", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "xpath",
      expression: "//td[1]",
      brittle: false,
      rationale: "Last resort.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a strategy missing rationale", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "role",
      role: "button",
      name: "Log In",
    });
    expect(result.success).toBe(false);
  });
});

describe("LocatorChainSchema", () => {
  it("rejects an empty chain", () => {
    const result = LocatorChainSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("accepts a multi-strategy chain", () => {
    const result = LocatorChainSchema.safeParse([
      { kind: "role", role: "button", name: "Search", rationale: "primary" },
      { kind: "css", selector: "button[type=submit]", brittle: true, rationale: "fallback" },
    ]);
    expect(result.success).toBe(true);
  });
});
