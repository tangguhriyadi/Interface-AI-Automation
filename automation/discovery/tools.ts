import { z } from "zod";

/**
 * The narrow, structured tool surface discovery offers the model — click,
 * type, select, read, done, escalate. No free navigation, no selectors, no
 * literal values ever pass through the model: see design decisions 3-4 in
 * docs/plans/03-discovery-loop.md.
 */

const refTargetShape = {
  frameId: z.string().min(1),
  ref: z.string().min(1),
};

export const ClickArgsSchema = z.object(refTargetShape);
export type ClickArgs = z.infer<typeof ClickArgsSchema>;

/**
 * `inputName` names a declared input — never a literal value. The
 * discovery loop resolves it to the actual runtime value server-side; the
 * model never sees or supplies typed text directly (design decision 3).
 */
export const TypeArgsSchema = z.object({ ...refTargetShape, inputName: z.string().min(1) });
export type TypeArgs = z.infer<typeof TypeArgsSchema>;

/** Same shape as `type` — a declared input's value chosen as an option, not typed. */
export const SelectArgsSchema = z.object({ ...refTargetShape, inputName: z.string().min(1) });
export type SelectArgs = z.infer<typeof SelectArgsSchema>;

/** `outputName` must name a declared, not-yet-written output — enforced by the discovery loop, not this schema alone. */
export const ReadArgsSchema = z.object({ ...refTargetShape, outputName: z.string().min(1) });
export type ReadArgs = z.infer<typeof ReadArgsSchema>;

/**
 * The model names the element that PROVES success — it never writes the
 * success condition itself, the same rule locators already follow (design
 * decision 4). `ref` omitted means "this frame's presence is the proof."
 * The discovery loop derives and verifies the actual Checkpoint from
 * whichever the model points at.
 */
export const DoneArgsSchema = z.object({
  proof: z.object({
    frameId: z.string().min(1),
    ref: z.string().min(1).optional(),
  }),
});
export type DoneArgs = z.infer<typeof DoneArgsSchema>;

export const EscalateArgsSchema = z.object({ reason: z.string().min(1) });
export type EscalateArgs = z.infer<typeof EscalateArgsSchema>;

export type ToolCall =
  | { tool: "click"; args: ClickArgs }
  | { tool: "type"; args: TypeArgs }
  | { tool: "select"; args: SelectArgs }
  | { tool: "read"; args: ReadArgs }
  | { tool: "done"; args: DoneArgs }
  | { tool: "escalate"; args: EscalateArgs };

const SCHEMAS_BY_TOOL_NAME = {
  click: ClickArgsSchema,
  type: TypeArgsSchema,
  select: SelectArgsSchema,
  read: ReadArgsSchema,
  done: DoneArgsSchema,
  escalate: EscalateArgsSchema,
} as const;

export type ParsedToolCall = { ok: true; call: ToolCall } | { ok: false; error: string };

/**
 * Validates a raw tool name + arguments (as returned by any model client)
 * against the narrow surface above. Never throws — an unknown tool name or
 * malformed arguments become a `{ ok: false }` result the discovery loop
 * turns into a tool-result error turn fed back to the model, never a
 * thrown exception that kills the run.
 */
export function parseToolCall(toolName: string, rawArgs: unknown): ParsedToolCall {
  const schema = SCHEMAS_BY_TOOL_NAME[toolName as keyof typeof SCHEMAS_BY_TOOL_NAME];
  if (!schema) {
    return {
      ok: false,
      error: `Unknown tool "${toolName}". Only click, type, select, read, done, and escalate exist.`,
    };
  }
  const result = schema.safeParse(rawArgs);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    return { ok: false, error: `Invalid arguments for tool "${toolName}": ${detail}` };
  }
  return { ok: true, call: { tool: toolName, args: result.data } as ToolCall };
}

/**
 * Anthropic tool-use definitions — hand-written JSON Schema mirroring the
 * Zod schemas above 1:1 (no zod-to-json-schema dependency for six small,
 * stable shapes). Keep both in sync when either changes.
 */
export const DISCOVERY_TOOL_DEFINITIONS = [
  {
    name: "click",
    description: "Click the interactive element identified by frameId+ref from the current snapshot view.",
    input_schema: {
      type: "object",
      properties: {
        frameId: { type: "string", description: "The frame the ref belongs to, exactly as shown in the snapshot view." },
        ref: { type: "string", description: "The ref of the element to click, exactly as shown in the snapshot view." },
      },
      required: ["frameId", "ref"],
    },
  },
  {
    name: "type",
    description:
      "Type a declared input's value into the textbox identified by frameId+ref. You never see or choose the literal value — name which declared input it is; the system supplies the value.",
    input_schema: {
      type: "object",
      properties: {
        frameId: { type: "string" },
        ref: { type: "string" },
        inputName: { type: "string", description: "The name of a declared input whose value should be typed here." },
      },
      required: ["frameId", "ref", "inputName"],
    },
  },
  {
    name: "select",
    description: "Choose a declared input's value as the option in the select/combobox identified by frameId+ref.",
    input_schema: {
      type: "object",
      properties: {
        frameId: { type: "string" },
        ref: { type: "string" },
        inputName: { type: "string", description: "The name of a declared input whose value should be selected here." },
      },
      required: ["frameId", "ref", "inputName"],
    },
  },
  {
    name: "read",
    description: "Read the value of the element identified by frameId+ref into a declared, not-yet-written output.",
    input_schema: {
      type: "object",
      properties: {
        frameId: { type: "string" },
        ref: { type: "string" },
        outputName: {
          type: "string",
          description: "The name of a declared output this reads a value into. Must not already be written.",
        },
      },
      required: ["frameId", "ref", "outputName"],
    },
  },
  {
    name: "done",
    description:
      "Declare the goal complete. Point at the element whose presence PROVES success — you choose which element; the system derives and verifies the actual condition from it, and refuses if it isn't true yet or if a declared output is still unwritten. You never write the condition yourself.",
    input_schema: {
      type: "object",
      properties: {
        proof: {
          type: "object",
          properties: {
            frameId: { type: "string", description: "The frame containing the proof." },
            ref: {
              type: "string",
              description:
                'Optional. The ref of a heading or text element whose presence proves success. Omit to instead prove success by the named frame\'s presence alone (not valid for the main frame, which is always present).',
            },
          },
          required: ["frameId"],
        },
      },
      required: ["proof"],
    },
  },
  {
    name: "escalate",
    description:
      "Stop and hand off to a human. Use this when the goal can't be completed safely or at all — for example an action was refused because it's classified irreversible, or you're stuck.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Why you're escalating." } },
      required: ["reason"],
    },
  },
] as const;
