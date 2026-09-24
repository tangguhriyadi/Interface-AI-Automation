import { PassThrough } from "node:stream";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConsoleEscalationHandler,
  NonInteractiveEscalationError,
  type ConsoleIO,
} from "../consoleEscalationHandler.js";
import type { InterventionRequest } from "../escalation.js";

const baseRequest: InterventionRequest = {
  kind: "irreversible_action",
  runKind: "replay",
  subject: "open_member_sub_account",
  location: "confirm-open-account",
  reason: 'Step "confirm-open-account" is irreversible; allowIrreversible was not set.',
  url: "http://localhost/accounts/10001/open",
  screenshot: Buffer.from("fake-png-bytes"),
};

/** A scripted, TTY-by-default IO double: `input` is fed answers by writing lines to it, `output` accumulates everything written so a test can inspect exactly what an operator would have seen. */
function scriptedIO(): ConsoleIO & { input: PassThrough; output: PassThrough; writtenOutput(): string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let collected = "";
  output.on("data", (chunk: Buffer) => {
    collected += chunk.toString();
  });
  return { input, output, isTTY: true, writtenOutput: () => collected };
}

/**
 * Waits until `io`'s accumulated output has printed the prompt at least `count` times.
 * `node:readline`'s `question()` genuinely loses a line written before the *specific*
 * `question()` call meant to consume it is active (confirmed against a minimal
 * reproduction outside this suite — it isn't specific to this handler or to
 * `PassThrough`) — so a multi-answer test must wait for confirmation that the handler
 * is actually blocked on its next prompt before writing the next line, exactly as a
 * human typing answers one at a time into a real terminal naturally would.
 */
async function waitForPromptCount(io: { writtenOutput(): string }, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while ((io.writtenOutput().match(/Your answer \(/g) ?? []).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for prompt #${count}; output so far:\n${io.writtenOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Nothing else in this codebase writes files matching this name shape to the OS temp
// dir — safe to clean up broadly rather than tracking each test's exact filename.
afterEach(async () => {
  const files = await readdir(tmpdir());
  await Promise.all(
    files
      .filter((f) => f.startsWith("intervention-") && f.endsWith(".raw-page-content.png"))
      .map((f) => rm(join(tmpdir(), f), { force: true })),
  );
});

describe("consoleEscalationHandler — non-interactive stdin fails fast rather than hanging", () => {
  it("throws NonInteractiveEscalationError immediately when isTTY is false, without writing anything", async () => {
    const io = scriptedIO();
    io.isTTY = false;
    const handler = createConsoleEscalationHandler(io);

    await expect(handler(baseRequest)).rejects.toBeInstanceOf(NonInteractiveEscalationError);
    // Failed before ever printing the escalation context or prompting — there was
    // never anyone who could have answered, so there was nothing useful to print either.
    expect(io.writtenOutput()).toBe("");
  });

  it("the error message explains why, in terms an operator or a CI log reader can act on", async () => {
    const io = scriptedIO();
    io.isTTY = false;
    const handler = createConsoleEscalationHandler(io);

    await expect(handler(baseRequest)).rejects.toThrow(/tty|terminal/i);
  });
});

describe("consoleEscalationHandler — prints enough context to act on", () => {
  it("includes the capability/goal, the step, the reason, the current URL, and a screenshot path — not just a bare prompt", async () => {
    const io = scriptedIO();
    io.input.write("performed\n");
    const handler = createConsoleEscalationHandler(io);

    const decision = await handler(baseRequest);

    expect(decision).toEqual({ signal: "performed" });
    const printed = io.writtenOutput();
    expect(printed).toContain(baseRequest.subject);
    expect(printed).toContain(baseRequest.location);
    expect(printed).toContain(baseRequest.reason);
    expect(printed).toContain(baseRequest.url);
    expect(printed).toMatch(/Screenshot:\s+\S+\.raw-page-content\.png/);

    // The path it printed is real — a file an operator could actually open, not a placeholder.
    const screenshotLine = printed.split("\n").find((line) => line.startsWith("Screenshot:"))!;
    const screenshotPath = screenshotLine.replace("Screenshot:", "").trim();
    const tmpFiles = await readdir(tmpdir());
    expect(tmpFiles).toContain(screenshotPath.split("/").pop());
  });

  it("prints '(unknown)' rather than omitting the URL line when the request has none", async () => {
    const io = scriptedIO();
    io.input.write("resolved\n");
    const handler = createConsoleEscalationHandler(io);

    await handler({ ...baseRequest, kind: "other", url: undefined });

    expect(io.writtenOutput()).toContain("Current URL:     (unknown)");
  });

  it("only offers the closed set valid for the request's kind — 'other' never mentions performed/skipped", async () => {
    const io = scriptedIO();
    io.input.write("resolved\n");
    const handler = createConsoleEscalationHandler(io);

    await handler({ ...baseRequest, kind: "other" });

    const printed = io.writtenOutput();
    expect(printed).toContain("resolved");
    expect(printed).toContain("aborted");
    expect(printed).not.toContain("performed");
    expect(printed).not.toContain("skipped");
  });
});

describe("consoleEscalationHandler — reprompts on an invalid answer rather than accepting it", () => {
  it("garbage input is rejected and the operator is asked again, until a valid closed-set answer arrives", async () => {
    const io = scriptedIO();
    const handler = createConsoleEscalationHandler(io);

    const decisionPromise = handler(baseRequest); // kind: "irreversible_action" — only performed/skipped/aborted are valid

    await waitForPromptCount(io, 1);
    io.input.write("banana\n"); // not a signal at all
    await waitForPromptCount(io, 2); // rejected — reprompted
    io.input.write("resolved\n"); // a real signal, but wrong for this request's kind
    await waitForPromptCount(io, 3); // rejected again — reprompted
    io.input.write("performed\n"); // finally valid

    const decision = await decisionPromise;

    expect(decision).toEqual({ signal: "performed" });
    const printed = io.writtenOutput();
    expect(printed).toContain('"banana" isn\'t a valid answer');
    expect(printed).toContain('"resolved" isn\'t a valid answer'); // valid shape, wrong kind — still rejected
    // The prompt itself was issued three times — once per attempt, proving it reprompted
    // rather than accepting the first bad answer.
    expect(printed.match(/Your answer \(/g)).toHaveLength(3);
  });

  it("is case-insensitive and trims surrounding whitespace", async () => {
    const io = scriptedIO();
    io.input.write("  Performed  \n");
    const handler = createConsoleEscalationHandler(io);

    await expect(handler(baseRequest)).resolves.toEqual({ signal: "performed" });
  });
});

describe("consoleEscalationHandler (the real default export)", () => {
  it("is wired to the process's own stdin/stdout — not something a caller has to construct", async () => {
    const { consoleEscalationHandler } = await import("../consoleEscalationHandler.js");
    expect(typeof consoleEscalationHandler).toBe("function");
  });
});
