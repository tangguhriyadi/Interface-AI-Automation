import { describe, expect, it } from "vitest";
import { ControlOwnershipError, createControlGate, isValidDecisionFor } from "../escalation.js";
import type { InterventionRequest } from "../escalation.js";
import { FakeAdapter, snapshotOf } from "./support/fakeAdapter.js";

const dummyRequest: InterventionRequest = {
  kind: "irreversible_action",
  runKind: "replay",
  subject: "test_capability",
  location: "open-account",
  reason: "test",
  url: "http://localhost/detail",
  screenshot: Buffer.from(""),
};

describe("isValidDecisionFor", () => {
  it("accepts performed/skipped/aborted for an irreversible_action request", () => {
    expect(isValidDecisionFor("irreversible_action", "performed")).toBe(true);
    expect(isValidDecisionFor("irreversible_action", "skipped")).toBe(true);
    expect(isValidDecisionFor("irreversible_action", "aborted")).toBe(true);
  });

  it("rejects resolved for an irreversible_action request — there's a specific action to have performed or skipped", () => {
    expect(isValidDecisionFor("irreversible_action", "resolved")).toBe(false);
  });

  it("accepts resolved/aborted for an 'other' request", () => {
    expect(isValidDecisionFor("other", "resolved")).toBe(true);
    expect(isValidDecisionFor("other", "aborted")).toBe(true);
  });

  it("rejects performed/skipped for an 'other' request — nothing to have performed or skipped", () => {
    expect(isValidDecisionFor("other", "performed")).toBe(false);
    expect(isValidDecisionFor("other", "skipped")).toBe(false);
  });
});

describe("createControlGate — enforced ownership, not implied by call-stack position", () => {
  it("lets automation operate the adapter normally before any control transfer", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [snapshotOf('- button "Go"\n')];
    const gate = createControlGate(adapter);

    expect(gate.adapter.currentOwner()).toBe("automation");
    await expect(gate.adapter.goto("/x")).resolves.toBeUndefined();
    await expect(gate.adapter.snapshot()).resolves.toBeDefined();
  });

  it("refuses every single method while control is ceded, and reports the operator as owner", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [snapshotOf('- button "Go"\n')];
    const gate = createControlGate(adapter);

    gate.cedeControl();
    expect(gate.adapter.currentOwner()).toBe("operator");

    const target = [{ kind: "role" as const, role: "button", name: "Go", exact: true, rationale: "x" }];
    await expect(gate.adapter.goto("/x")).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.click(target)).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.type(target, "v")).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.select(target, "v")).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.read(target)).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.snapshot()).rejects.toBeInstanceOf(ControlOwnershipError);
    await expect(gate.adapter.screenshot()).rejects.toBeInstanceOf(ControlOwnershipError);
    expect(() => gate.adapter.lastNavigationStatus()).toThrow(ControlOwnershipError);
  });

  it("close() is teardown, not a page operation — it always runs, even while control is ceded", async () => {
    // A finally block whose whole job is to release the browser (an operator aborting, a
    // handler throwing) must always be able to call close(). Gating it would mean the one
    // call meant to always succeed could itself throw at exactly the moment nothing else can.
    const adapter = new FakeAdapter();
    const gate = createControlGate(adapter);
    gate.cedeControl();
    await expect(gate.adapter.close()).resolves.toBeUndefined();
  });

  it("the error names which operation was refused", async () => {
    const adapter = new FakeAdapter();
    const gate = createControlGate(adapter);
    gate.cedeControl();
    await expect(gate.adapter.snapshot()).rejects.toThrow(/snapshot/);
  });

  it("lets automation resume normal operation once control returns", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [snapshotOf('- button "Go"\n'), snapshotOf('- button "Go"\n')];
    const gate = createControlGate(adapter);

    gate.cedeControl();
    await expect(gate.adapter.snapshot()).rejects.toBeInstanceOf(ControlOwnershipError);

    gate.returnControl();
    expect(gate.adapter.currentOwner()).toBe("automation");
    await expect(gate.adapter.snapshot()).resolves.toBeDefined();
  });

  it("never delegates to the underlying adapter while ceded — the real FakeAdapter call never happens", async () => {
    const adapter = new FakeAdapter();
    const gate = createControlGate(adapter);
    gate.cedeControl();
    await gate.adapter.goto("/should-not-happen").catch(() => undefined);
    expect(adapter.gotoLog).toHaveLength(0);
  });
});

describe("ControlGate.withOperatorControl — cede/return can't be forgotten on an error path", () => {
  it("cedes control for the handler's duration and returns it once the handler resolves", async () => {
    const adapter = new FakeAdapter();
    const gate = createControlGate(adapter);
    let ownerDuringHandler: string | undefined;

    const decision = await gate.withOperatorControl(async (request) => {
      ownerDuringHandler = gate.adapter.currentOwner();
      expect(request).toBe(dummyRequest);
      return { signal: "performed" };
    }, dummyRequest);

    expect(ownerDuringHandler).toBe("operator");
    expect(decision).toEqual({ signal: "performed" });
    expect(gate.adapter.currentOwner()).toBe("automation");
  });

  it("returns control even when the handler throws — the exact bug a manual cede/return pair risks", async () => {
    const adapter = new FakeAdapter();
    const gate = createControlGate(adapter);

    await expect(
      gate.withOperatorControl(async () => {
        throw new Error("operator console crashed");
      }, dummyRequest),
    ).rejects.toThrow("operator console crashed");

    // Without the finally, ownership would be stuck on "operator" forever and every
    // later adapter call would fail — this proves it isn't.
    expect(gate.adapter.currentOwner()).toBe("automation");
    adapter.snapshotQueue = [snapshotOf('- button "Go"\n')];
    await expect(gate.adapter.snapshot()).resolves.toBeDefined();
  });
});
