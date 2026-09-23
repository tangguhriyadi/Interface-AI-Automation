import { describe, expect, it } from "vitest";
import { DISCOVERY_TOOL_DEFINITIONS, parseToolCall } from "../../discovery/tools.js";

describe("parseToolCall", () => {
  it("rejects an unknown tool name", () => {
    const result = parseToolCall("navigate", { url: "http://example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown tool "navigate"');
    }
  });

  describe("click", () => {
    it("accepts frameId + ref", () => {
      const result = parseToolCall("click", { frameId: "main", ref: "7" });
      expect(result).toEqual({ ok: true, call: { tool: "click", args: { frameId: "main", ref: "7" } } });
    });

    it("rejects a missing ref", () => {
      const result = parseToolCall("click", { frameId: "main" });
      expect(result.ok).toBe(false);
    });
  });

  describe("type", () => {
    it("accepts frameId + ref + inputName — never a literal value field", () => {
      const result = parseToolCall("type", { frameId: "main", ref: "3", inputName: "username" });
      expect(result).toEqual({
        ok: true,
        call: { tool: "type", args: { frameId: "main", ref: "3", inputName: "username" } },
      });
    });

    it("rejects a literal value field in place of inputName", () => {
      const result = parseToolCall("type", { frameId: "main", ref: "3", value: "teller" });
      expect(result.ok).toBe(false);
    });
  });

  describe("select", () => {
    it("accepts frameId + ref + inputName", () => {
      const result = parseToolCall("select", { frameId: "main", ref: "9", inputName: "accountType" });
      expect(result.ok).toBe(true);
    });

    it("rejects a missing inputName", () => {
      const result = parseToolCall("select", { frameId: "main", ref: "9" });
      expect(result.ok).toBe(false);
    });
  });

  describe("read", () => {
    it("accepts frameId + ref + outputName", () => {
      const result = parseToolCall("read", { frameId: "iframe:Account Balance", ref: "11", outputName: "savingsBalance" });
      expect(result.ok).toBe(true);
    });

    it("rejects a missing outputName", () => {
      const result = parseToolCall("read", { frameId: "main", ref: "11" });
      expect(result.ok).toBe(false);
    });
  });

  describe("done", () => {
    it("accepts a proof naming a ref", () => {
      const result = parseToolCall("done", { proof: { frameId: "main", ref: "2" } });
      expect(result).toEqual({ ok: true, call: { tool: "done", args: { proof: { frameId: "main", ref: "2" } } } });
    });

    it("accepts a proof naming only a frameId (frame-presence proof)", () => {
      const result = parseToolCall("done", { proof: { frameId: "iframe:Account Balance" } });
      expect(result.ok).toBe(true);
    });

    it("rejects a proof with no frameId at all", () => {
      const result = parseToolCall("done", { proof: { ref: "2" } });
      expect(result.ok).toBe(false);
    });

    it("rejects a done call that supplies a literal checkpoint instead of a proof ref — the model never authors the condition", () => {
      const result = parseToolCall("done", { successCheckpoint: { kind: "heading_starts_with", text: "Member:" } });
      expect(result.ok).toBe(false);
    });
  });

  describe("escalate", () => {
    it("accepts a reason", () => {
      const result = parseToolCall("escalate", { reason: "The goal requires clicking a control classified irreversible." });
      expect(result.ok).toBe(true);
    });

    it("rejects an empty reason", () => {
      const result = parseToolCall("escalate", { reason: "" });
      expect(result.ok).toBe(false);
    });
  });
});

describe("DISCOVERY_TOOL_DEFINITIONS", () => {
  it("declares exactly the six narrow tools, nothing more", () => {
    expect(DISCOVERY_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
      ["click", "done", "escalate", "read", "select", "type"].sort(),
    );
  });

  it("every definition has a non-empty description and an object input_schema", () => {
    for (const tool of DISCOVERY_TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input_schema.type).toBe("object");
    }
  });
});
