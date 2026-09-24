import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  isValidDecisionFor,
  type EscalationHandler,
  type InterventionDecision,
  type InterventionRequest,
  type InterventionSignal,
} from "./escalation.js";
import { screenshotFileName } from "./evidence.js";

/**
 * The minimal, real operator surface the brief allows: a terminal prompt on
 * real stdin/stdout against the same live browser session automation was
 * just driving (see `escalation.ts`'s own doc comment for the
 * single-process/same-machine seam this implies). Deliberately not the
 * final evidence record — `evidence.ts` writes the run's permanent
 * `intervention-N.raw-page-content.png` after the whole run finishes; this
 * one exists only so an operator mid-run has something to open and look at
 * right now, and is written under the OS temp directory rather than
 * `/evidence/`, so a demo run doesn't litter the repo with a duplicate of
 * what evidence.ts is about to write anyway.
 */

const ALL_SIGNALS: readonly InterventionSignal[] = ["performed", "skipped", "resolved", "aborted"];

function isKnownSignal(value: string): value is InterventionSignal {
  return (ALL_SIGNALS as readonly string[]).includes(value);
}

function validSignalsFor(kind: InterventionRequest["kind"]): InterventionSignal[] {
  return ALL_SIGNALS.filter((signal) => isValidDecisionFor(kind, signal));
}

/**
 * Thrown instead of prompting when stdin isn't a TTY — piped input, a CI
 * runner, a backgrounded process. There is no terminal on the other end to
 * answer an interactive question, so waiting on `readline` would hang
 * forever on an answer that can never arrive. Failing immediately, loudly,
 * and with a clear explanation is strictly better than a silent hang.
 */
export class NonInteractiveEscalationError extends Error {
  constructor() {
    super(
      "An escalation was raised but stdin is not a TTY, so there is no interactive terminal to prompt an operator on. " +
        "consoleEscalationHandler needs a real terminal (run the CLI directly, not piped, redirected, or backgrounded) " +
        "so a human can actually respond — waiting here would hang forever on an answer that can never arrive.",
    );
    this.name = "NonInteractiveEscalationError";
  }
}

async function saveScreenshotForOperator(request: InterventionRequest): Promise<string> {
  const path = join(tmpdir(), screenshotFileName(`intervention-${Date.now()}`));
  await writeFile(path, request.screenshot);
  return path;
}

export interface ConsoleIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /**
   * Whether `input` is an interactive terminal. A real seam, not `input`'s
   * own `.isTTY` — a test double (a `PassThrough`, say) has no such
   * property, and deriving it from stream duck-typing would be more
   * fragile than just stating it.
   */
  isTTY: boolean;
}

function defaultIO(): ConsoleIO {
  return { input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY) };
}

/** Every informational line goes through `io.output` directly, same as `readline`'s own prompt does — nothing here relies on the real `console`, so a scripted `io` in tests sees everything a real operator would. */
function print(io: ConsoleIO, text: string): void {
  io.output.write(`${text}\n`);
}

/**
 * Builds a real `EscalationHandler` against the given IO — `io` defaults to
 * the process's own stdin/stdout, which is what the CLI actually uses;
 * tests pass a scripted `io` instead so they can drive real `readline`
 * behavior (reprompting, TTY detection) without a real terminal.
 */
export function createConsoleEscalationHandler(io: ConsoleIO = defaultIO()): EscalationHandler {
  return async (request: InterventionRequest): Promise<InterventionDecision> => {
    if (!io.isTTY) {
      throw new NonInteractiveEscalationError();
    }

    const screenshotPath = await saveScreenshotForOperator(request);
    const validSignals = validSignalsFor(request.kind);

    print(io, "");
    print(io, "=".repeat(72));
    print(io, "ESCALATION — automation has paused and ceded control of the browser.");
    print(io, "=".repeat(72));
    print(io, `Run kind:        ${request.runKind}`);
    print(io, `Capability/goal: ${request.subject}`);
    print(io, `Step/turn:       ${request.location}`);
    print(io, `Reason:          ${request.reason}`);
    print(io, `Current URL:     ${request.url ?? "(unknown)"}`);
    print(io, `Screenshot:      ${screenshotPath}`);
    print(io, "");
    print(io, "The browser window is waiting for you — act in it directly, then answer below.");
    print(io, "");

    const rl = createInterface({ input: io.input, output: io.output });
    try {
      for (;;) {
        const raw = (await rl.question(`Your answer (${validSignals.join(" / ")}): `)).trim().toLowerCase();
        if (isKnownSignal(raw) && isValidDecisionFor(request.kind, raw)) {
          return { signal: raw };
        }
        print(io, `"${raw}" isn't a valid answer for this escalation — expected one of: ${validSignals.join(", ")}. Try again.`);
      }
    } finally {
      rl.close();
    }
  };
}

export const consoleEscalationHandler: EscalationHandler = createConsoleEscalationHandler();
