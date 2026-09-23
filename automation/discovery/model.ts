import Anthropic from "@anthropic-ai/sdk";
import type { Sensitivity } from "../schema/capability.js";
import type { CompactFrameView, CompactSnapshot } from "./compactView.js";
import { DISCOVERY_TOOL_DEFINITIONS, parseToolCall, type ToolCall } from "./tools.js";

export interface DiscoveryGoalInfo {
  description: string;
  /** Names and sensitivity only — never literal values. The model resolves an input by name (tools.ts's `inputName`); it never sees what it types. */
  declaredInputs: { name: string; sensitivity: Sensitivity }[];
  declaredOutputs: { name: string; sensitivity: Sensitivity }[];
}

export interface TurnHistoryEntry {
  toolCall: ToolCall;
  /** Plain-text summary of what happened, fed back to the model as the result of its last action. The discovery loop is responsible for keeping this free of literal secret/pii values before constructing it — this type makes no redaction guarantee of its own. */
  result: string;
}

/**
 * Everything a model needs to choose the next action, and nothing more —
 * `chooseNextAction` is stateless (see `DiscoveryModel` below), so this
 * carries the full turn history rather than relying on any implementation
 * to remember it.
 */
export interface DiscoveryContext {
  goal: DiscoveryGoalInfo;
  /** Which declared outputs have already been written this run. */
  writtenOutputs: string[];
  compactSnapshot: CompactSnapshot;
  history: TurnHistoryEntry[];
}

export type ModelTurn =
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "malformed"; toolName: string; error: string };

/**
 * How the discovery loop talks to whatever chooses the next action — the
 * same seam `SurfaceAdapter` (adapter/surfaceAdapter.ts) is for Playwright:
 * only this file imports `@anthropic-ai/sdk`. Stateless by design: every
 * call receives the full context it needs and returns exactly one turn —
 * nothing is retained between calls inside an implementation, so a fake
 * test double needs no bookkeeping to match real usage, and `AnthropicModel`
 * needs none beyond the SDK client itself.
 */
export interface DiscoveryModel {
  chooseNextAction(context: DiscoveryContext): Promise<ModelTurn>;
}

function describeFrame(frame: CompactFrameView): string {
  return frame.frame ? `[frame ${frame.frameId}: ${frame.frame.by}="${frame.frame.value}"]` : `[frame ${frame.frameId}: main]`;
}

function describeNode(node: CompactFrameView["nodes"][number]): string {
  const parts = [`ref=${node.ref}`, node.role];
  if (node.name !== undefined) {
    parts.push(`"${node.name}"`);
  }
  if (node.value !== undefined) {
    parts.push(`value="${node.value}"`);
  }
  if (node.rowHeader !== undefined) {
    parts.push(`(row header: "${node.rowHeader}")`);
  }
  return `  ${parts.join(" ")}`;
}

/** Renders the compact snapshot as plain text for the model — no JSON, so it reads like the "compact, redacted view" CLAUDE.md describes rather than a data dump. */
export function formatSnapshotForModel(snapshot: CompactSnapshot): string {
  const lines: string[] = [];
  for (const frame of snapshot.frames) {
    lines.push(describeFrame(frame));
    for (const node of frame.nodes) {
      lines.push(describeNode(node));
    }
  }
  return lines.join("\n");
}

/** The system prompt: the goal, the tool contract, and the declared inputs/outputs by name only — never a literal value. */
export function buildSystemPrompt(goal: DiscoveryGoalInfo): string {
  const inputList = goal.declaredInputs.map((i) => `- ${i.name} (${i.sensitivity})`).join("\n") || "(none)";
  const outputList = goal.declaredOutputs.map((o) => `- ${o.name} (${o.sensitivity})`).join("\n") || "(none)";
  return [
    `You are driving a web UI to complete this goal: ${goal.description}`,
    "",
    "You perceive the page only through a compact snapshot view: each turn shows every interactive or readable element as a ref within a frame. You never see raw HTML and you never write CSS/XPath selectors — you only ever name a frameId+ref taken from the snapshot you were just shown.",
    "",
    "You act only through the six tools provided:",
    "- click(frameId, ref)",
    "- type(frameId, ref, inputName) — inputName must be one of the declared inputs below; you never supply or see the literal value, the system types it for you",
    "- select(frameId, ref, inputName) — same as type, for a select/combobox",
    "- read(frameId, ref, outputName) — outputName must be one of the declared outputs below, and not already written",
    "- done(proof) — point at the ref (or, to prove success by a whole frame's presence, name only the frameId) whose presence proves the goal succeeded; the system verifies this itself and refuses if it isn't true yet, or if any declared output is still unwritten",
    "- escalate(reason) — stop and hand off to a human when the goal can't be completed safely or at all",
    "",
    "There is no way to navigate to an arbitrary URL. Every transition happens by acting on the page.",
    "",
    `Declared inputs:\n${inputList}`,
    "",
    `Declared outputs (all must be written before done is accepted):\n${outputList}`,
  ].join("\n");
}

function toolUseId(index: number): string {
  return `turn-${index}`;
}

/**
 * Reconstructs the message array from scratch each call, since `DiscoveryModel`
 * is stateless — an assistant tool_use + user tool_result pair per past
 * turn, then one trailing user message with the current snapshot to act on.
 */
export function buildMessages(context: DiscoveryContext): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  context.history.forEach((entry, index) => {
    const id = toolUseId(index);
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id, name: entry.toolCall.tool, input: entry.toolCall.args }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: entry.result }],
    });
  });
  messages.push({
    role: "user",
    content: `Current snapshot:\n${formatSnapshotForModel(context.compactSnapshot)}`,
  });
  return messages;
}

/**
 * Turns an SDK response's content blocks into a `ModelTurn` — pure and
 * directly testable without a network call. `AnthropicModel.chooseNextAction`
 * is the only place that actually calls the API; everything else is pure.
 */
export function parseModelResponse(content: Anthropic.ContentBlock[]): ModelTurn {
  const toolUse = content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    return {
      kind: "malformed",
      toolName: "(none)",
      error: "Model response contained no tool_use block despite tool_choice being forced.",
    };
  }
  const parsed = parseToolCall(toolUse.name, toolUse.input);
  if (!parsed.ok) {
    return { kind: "malformed", toolName: toolUse.name, error: parsed.error };
  }
  return { kind: "tool_call", call: parsed.call };
}

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

export interface AnthropicModelOptions {
  apiKey?: string;
  model?: string;
}

/** The only file in this project that imports `@anthropic-ai/sdk` — the discovery-side counterpart to `adapter/playwrightAdapter.ts` being the only file importing `playwright`. */
export class AnthropicModel implements DiscoveryModel {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicModelOptions = {}) {
    this.client = new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.model = options.model ?? process.env.DISCOVERY_MODEL ?? DEFAULT_MODEL;
  }

  async chooseNextAction(context: DiscoveryContext): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(context.goal),
      messages: buildMessages(context),
      tools: DISCOVERY_TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    return parseModelResponse(response.content);
  }
}
