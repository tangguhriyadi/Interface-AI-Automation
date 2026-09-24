import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildMessages,
  buildSystemPrompt,
  formatSnapshotForModel,
  parseModelResponse,
  type DiscoveryContext,
  type DiscoveryGoalInfo,
} from "../../discovery/model.js";
import type { CompactSnapshot } from "../../discovery/compactView.js";

const goal: DiscoveryGoalInfo = {
  description: "Look up a member's savings balance by memberId.",
  declaredInputs: [
    { name: "username", sensitivity: "none" },
    { name: "password", sensitivity: "secret" },
    { name: "memberId", sensitivity: "pii" },
  ],
  declaredOutputs: [
    { name: "memberName", sensitivity: "pii" },
    { name: "savingsBalance", sensitivity: "pii" },
  ],
};

const snapshot: CompactSnapshot = {
  frames: [
    {
      frameId: "main",
      nodes: [
        { frameId: "main", ref: "1", role: "textbox", name: "Username" },
        { frameId: "main", ref: "2", role: "button", name: "Log In" },
      ],
    },
    {
      frameId: "iframe:Account Balance",
      frame: { by: "title", value: "Account Balance" },
      nodes: [{ frameId: "iframe:Account Balance", ref: "11", role: "cell", rowHeader: "Savings" }],
    },
  ],
};

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt(goal);

  it("includes the goal description", () => {
    expect(prompt).toContain("Look up a member's savings balance by memberId.");
  });

  it("lists every declared input by name and sensitivity — never a literal value", () => {
    expect(prompt).toContain("username (none)");
    expect(prompt).toContain("password (secret)");
    expect(prompt).toContain("memberId (pii)");
    expect(prompt).not.toContain("teller");
  });

  it("lists every declared output by name and sensitivity", () => {
    expect(prompt).toContain("memberName (pii)");
    expect(prompt).toContain("savingsBalance (pii)");
  });

  it("states there is no free navigation", () => {
    expect(prompt).toMatch(/no way to navigate to an arbitrary URL/i);
  });

  it("renders '(none)' for a goal with no declared inputs or outputs", () => {
    const bare = buildSystemPrompt({ description: "x", declaredInputs: [], declaredOutputs: [] });
    expect(bare).toContain("Declared inputs:\n(none)");
    expect(bare).toContain("Declared outputs (all must be written before done is accepted):\n(none)");
  });
});

describe("formatSnapshotForModel", () => {
  const text = formatSnapshotForModel(snapshot);

  it("labels the main frame plainly", () => {
    expect(text).toContain('[frame frameId="main"]');
  });

  it("describes a named frame by how it's identified, with frameId quoted and unambiguous", () => {
    expect(text).toContain('[frame frameId="iframe:Account Balance" title="Account Balance"]');
  });

  it("keeps frameId parseable even though it contains a colon itself — the bug found live", () => {
    // A naive split on ": " would previously have swallowed the trailing title="..." into
    // what looked like the frameId. Quoting frameId as its own key=value pair prevents that.
    const frameLine = text.split("\n").find((line) => line.includes("Account Balance"))!;
    const match = frameLine.match(/frameId="([^"]*)"/);
    expect(match?.[1]).toBe("iframe:Account Balance");
  });

  it("includes ref, role, and name for a node", () => {
    expect(text).toContain('ref=1 textbox "Username"');
  });

  it("includes the row-header hint for a nameless structural node", () => {
    expect(text).toContain('ref=11 cell (row header: "Savings")');
  });
});

describe("buildMessages", () => {
  it("appends a trailing user message with the current snapshot when history is empty", () => {
    const context: DiscoveryContext = { goal, writtenOutputs: [], compactSnapshot: snapshot, history: [] };
    const messages = buildMessages(context);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]!.content).toContain("Current snapshot:");
  });

  it("reconstructs an assistant tool_use + user tool_result pair per history entry, plus the trailing snapshot message", () => {
    const context: DiscoveryContext = {
      goal,
      writtenOutputs: [],
      compactSnapshot: snapshot,
      history: [
        { toolCall: { tool: "click", args: { frameId: "main", ref: "2" } }, result: "clicked" },
        { toolCall: { tool: "read", args: { frameId: "main", ref: "11", outputName: "savingsBalance" } }, result: "read: [REDACTED:pii] into savingsBalance" },
      ],
    };
    const messages = buildMessages(context);
    expect(messages).toHaveLength(5); // 2 pairs + 1 trailing
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect((messages[0]!.content as Anthropic.ToolUseBlockParam[])[0]).toMatchObject({
      type: "tool_use",
      name: "click",
      input: { frameId: "main", ref: "2" },
    });
    expect(messages[1]).toMatchObject({ role: "user" });
    expect((messages[1]!.content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject({
      type: "tool_result",
      content: "clicked",
    });
    // Matching tool_use_id between a pair, and distinct ids across pairs.
    const firstToolUseId = (messages[0]!.content as Anthropic.ToolUseBlockParam[])[0]!.id;
    const firstToolResultId = (messages[1]!.content as Anthropic.ToolResultBlockParam[])[0]!.tool_use_id;
    const secondToolUseId = (messages[2]!.content as Anthropic.ToolUseBlockParam[])[0]!.id;
    expect(firstToolUseId).toBe(firstToolResultId);
    expect(secondToolUseId).not.toBe(firstToolUseId);
    expect(messages[4]).toMatchObject({ role: "user" });
    expect(messages[4]!.content).toContain("Current snapshot:");
  });

  it("never puts a literal secret/pii input value into a tool_result — the history entry's own redaction discipline is trusted verbatim", () => {
    const context: DiscoveryContext = {
      goal,
      writtenOutputs: ["savingsBalance"],
      compactSnapshot: snapshot,
      history: [
        {
          toolCall: { tool: "type", args: { frameId: "main", ref: "1", inputName: "password" } },
          result: "typed into password field",
        },
      ],
    };
    const messages = buildMessages(context);
    expect(JSON.stringify(messages)).not.toContain("local-dev-only");
  });
});

describe("parseModelResponse", () => {
  it("turns a tool_use content block into a tool_call turn", () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "click", input: { frameId: "main", ref: "2" }, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
    ];
    const turn = parseModelResponse(content);
    expect(turn).toEqual({ kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: "2" } } });
  });

  it("returns malformed when the response has no tool_use block at all", () => {
    const content: Anthropic.ContentBlock[] = [{ type: "text", text: "I'm thinking...", citations: [] } as Anthropic.TextBlock];
    const turn = parseModelResponse(content);
    expect(turn.kind).toBe("malformed");
  });

  it("returns malformed with a clear error when the tool_use block's arguments fail validation", () => {
    const content: Anthropic.ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "click", input: { frameId: "main" }, caller: { type: "direct" } } as Anthropic.ToolUseBlock,
    ];
    const turn = parseModelResponse(content);
    expect(turn.kind).toBe("malformed");
    if (turn.kind === "malformed") {
      expect(turn.error).toContain("Invalid arguments");
    }
  });
});
