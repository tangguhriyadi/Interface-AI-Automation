import { describe, expect, it } from "vitest";
import { ControlOwnershipError, createControlGate, isValidDecisionFor } from "../escalation.js";
import { FakeAdapter, snapshotOf } from "./support/fakeAdapter.js";

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
    await expect(gate.adapter.close()).rejects.toBeInstanceOf(ControlOwnershipError);
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
