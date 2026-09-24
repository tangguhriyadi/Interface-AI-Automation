import type { FrameRef } from "./schema/frame.js";
import type { LocatorChain } from "./schema/locator.js";
import type { ActionResult, ReadResult, SurfaceAdapter } from "./adapter/surfaceAdapter.js";
import type { Snapshot } from "./adapter/snapshotParser.js";

/**
 * The human-in-the-loop escalation handoff: when `replay()`/`discover()`
 * would otherwise return `escalated` and stop, an optional `onEscalation`
 * handler is awaited in its place — the same live `SurfaceAdapter`/browser
 * session stays open throughout, real JS call-stack suspension is the
 * pause. This is genuinely correct at the scope being built, but it has a
 * real boundary worth naming rather than leaving implied: **the session
 * lives only as long as this Node process, the operator has to be on the
 * same machine, and a crash mid-pause loses the run.** In production, an
 * intervention request would be routed to an operator who might be
 * anywhere — a queue, not a direct function call — and the browser session
 * would need to outlive this process entirely (a remote/detachable browser
 * context, session persistence, reattachment from a different process).
 * The operator console here is deliberately minimal (a terminal prompt);
 * the control-transfer *model* underneath it is real.
 */

export type ControlOwner = "automation" | "operator";

/**
 * Only an escalation that's actually *about an irreversible action*
 * (replay's two escalation points; discovery's `action_refused_irreversible`
 * reasonCode) offers `performed | skipped | aborted` — there's a concrete
 * action to have performed or skipped. Every other escalation reason
 * (discovery's `stuck`, `unexpected_state`, `cannot_complete`,
 * `recovery_exhausted`, `recovery_action_failed`) offers `resolved | aborted`
 * instead — forcing `performed`/`skipped` onto "the model is stuck" would be
 * dishonest, there's no action either of those describes.
 */
export type InterventionKind = "irreversible_action" | "other";

export type InterventionSignal = "performed" | "skipped" | "resolved" | "aborted";

const VALID_SIGNALS_BY_KIND: Record<InterventionKind, readonly InterventionSignal[]> = {
  irreversible_action: ["performed", "skipped", "aborted"],
  other: ["resolved", "aborted"],
};

/** A closed-set check, not a free-text one — the same discipline `discovery/tools.ts`'s `escalate` redesign already established, applied to the human side of the same channel. */
export function isValidDecisionFor(kind: InterventionKind, signal: InterventionSignal): boolean {
  return VALID_SIGNALS_BY_KIND[kind].includes(signal);
}

export interface InterventionRequest {
  kind: InterventionKind;
  runKind: "replay" | "discovery";
  /** The capabilityId (replay) or goal description (discovery). */
  subject: string;
  /** A human-readable location: the current step id (replay) or turn count (discovery). */
  location: string;
  /** Already redaction-safe — reuses the same composed/classified reasoning every other terminal outcome in this codebase already produces. Never raw page content. */
  reason: string;
  url: string | undefined;
  /**
   * Captured at the instant of escalation, before control is ceded — never
   * serialize this directly into JSON (evidence.ts writes it to its own
   * file and replaces this field with a path). CLAUDE.md's Perception
   * Model: evidence and escalation context only, never a basis for
   * deciding an action.
   */
  screenshot: Buffer;
}

export interface InterventionDecision {
  signal: InterventionSignal;
}

export interface InterventionRecord {
  request: InterventionRequest;
  decision: InterventionDecision;
  raisedAt: string;
  resumedAt: string;
}

/**
 * Given a request, returns the operator's decision — control is ceded for
 * exactly as long as this promise is pending. The default operator surface
 * is `consoleEscalationHandler`; a test double queues decisions the same
 * way `FakeModel`/`FakeAdapter` script their own behavior.
 */
export type EscalationHandler = (request: InterventionRequest) => Promise<InterventionDecision>;

/** Thrown by a `ControlGatedAdapter` method when called while control is ceded to the operator. */
export class ControlOwnershipError extends Error {
  constructor(operation: string) {
    super(
      `Cannot call SurfaceAdapter.${operation}() — control is currently ceded to the operator. ` +
        "Automation must not touch the page while a human is acting in the same session.",
    );
    this.name = "ControlOwnershipError";
  }
}

export interface ControlGatedAdapter extends SurfaceAdapter {
  /** Explicit, inspectable control state — not inferred from where an `await` happens to be suspended. */
  currentOwner(): ControlOwner;
}

export interface ControlGate {
  adapter: ControlGatedAdapter;
  cedeControl(): void;
  returnControl(): void;
}

/**
 * Wraps a `SurfaceAdapter` so every single method — including read-only
 * ones like `snapshot`/`screenshot`/`lastNavigationStatus` — refuses to run
 * while control is ceded to an operator. This is an *enforced* invariant,
 * not a consequence of nothing happening to call the adapter during a
 * suspended `await`: a future bug (a badly-behaved handler, a missed
 * `returnControl()`) would otherwise fail silently instead of loudly. Every
 * method is gated, not just the acting ones — even an observation could
 * reflect a mid-action, inconsistent page state while a human is working.
 */
export function createControlGate(adapter: SurfaceAdapter): ControlGate {
  let owner: ControlOwner = "automation";

  function assertAutomationOwns(operation: string): void {
    if (owner !== "automation") {
      throw new ControlOwnershipError(operation);
    }
  }

  const gated: ControlGatedAdapter = {
    async goto(path: string): Promise<void> {
      assertAutomationOwns("goto");
      return adapter.goto(path);
    },
    async click(target: LocatorChain, frame?: FrameRef): Promise<ActionResult> {
      assertAutomationOwns("click");
      return adapter.click(target, frame);
    },
    async type(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult> {
      assertAutomationOwns("type");
      return adapter.type(target, value, frame);
    },
    async select(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult> {
      assertAutomationOwns("select");
      return adapter.select(target, value, frame);
    },
    async read(target: LocatorChain, frame?: FrameRef): Promise<ReadResult> {
      assertAutomationOwns("read");
      return adapter.read(target, frame);
    },
    async snapshot(): Promise<Snapshot> {
      assertAutomationOwns("snapshot");
      return adapter.snapshot();
    },
    lastNavigationStatus(): number | undefined {
      assertAutomationOwns("lastNavigationStatus");
      return adapter.lastNavigationStatus();
    },
    async screenshot(): Promise<Buffer> {
      assertAutomationOwns("screenshot");
      return adapter.screenshot();
    },
    async close(): Promise<void> {
      assertAutomationOwns("close");
      return adapter.close();
    },
    currentOwner(): ControlOwner {
      return owner;
    },
  };

  return {
    adapter: gated,
    cedeControl: () => {
      owner = "operator";
    },
    returnControl: () => {
      owner = "automation";
    },
  };
}
