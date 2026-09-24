import { describe, expect, it } from "vitest";
import type { AppProfile } from "../../schema/appProfile.js";
import type { CapabilityArtifact } from "../../schema/capability.js";
import type { LocatorStrategy } from "../../schema/locator.js";
import { replay } from "../../executor/replay.js";
import { FakeAdapter, snapshotOf } from "../support/fakeAdapter.js";

function role(roleName: string, name: string): LocatorStrategy {
  return { kind: "role", role: roleName, name, exact: true, rationale: "test" };
}

// A minimal 2-step capability (click, then read) is enough to exercise every
// transition-check branch without the snapshot-queue bookkeeping exploding.
const baseCapability: CapabilityArtifact = {
  schemaVersion: "1.0.0",
  capabilityId: "test_capability",
  version: "1.0.0",
  appId: "test-app",
  entryPoint: "/login",
  inputs: {},
  outputs: { value: { type: "string", sensitivity: "none" } },
  steps: [
    { id: "click-go", action: "click", classification: "safe", continuesAfterSkip: false, target: [role("button", "Go")] },
    {
      id: "read-value",
      action: "read",
      classification: "safe",
      continuesAfterSkip: false,
      target: [role("cell", "Value")],
      outputName: "value",
    },
  ],
  successCheckpoint: { kind: "heading_starts_with", text: "Detail" },
  businessOutcomes: ["not_found"],
  approvalState: "approved",
};

const appProfile: AppProfile = {
  schemaVersion: "1.0.0",
  appId: "test-app",
  outcomes: {
    not_found: { name: "not_found", shapes: [{ headingEquals: "Not Found" }] },
  },
  recoveries: [
    {
      name: "interstitial",
      detect: [{ headingEquals: "Maintenance" }],
      action: { kind: "dismiss", locator: [role("button", "Dismiss")] },
    },
  ],
  // Matches target-app's real, observed expired-session rendering: same heading as the
  // plain login page, distinguished only by a role=alert notice (evidence/app-profile-verification/session-expired.aria.yaml).
  sessionExpiry: [{ headingEquals: "Log In", roleAlertContains: "session expired" }],
  irreversibleControls: [],
  allowlist: { originPattern: "http://localhost", routePrefixes: ["/login", "/detail"] },
};

const loginSnapshot = snapshotOf('- heading "Log In" [level=1]', "http://localhost/login");
// Same heading as the plain login page — only the alert distinguishes it, exactly like
// the real app (see the sessionExpiry comment above).
const expiredLoginSnapshot = snapshotOf(
  '- heading "Log In" [level=1]\n- alert: Your session expired. Please log in again.',
  "http://localhost/login",
);
const detailSnapshot = snapshotOf('- heading "Detail Page" [level=1]', "http://localhost/detail");
const notFoundSnapshot = snapshotOf('- heading "Not Found" [level=1]', "http://localhost/detail");
const maintenanceSnapshot = snapshotOf('- heading "Maintenance" [level=1]', "http://localhost/detail");

describe("replay — happy path", () => {
  it("returns success with outputs and empty recoveries when every transition is clean", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, detailSnapshot];
    adapter.readValue = "the-value";

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs).toEqual({ value: "the-value" });
    }
    expect(result.recoveries).toEqual([]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.outcome === "ok")).toBe(true);
    expect(result.steps[1]!.matchedStrategy).toBe("role");
  });
});

describe("replay — per-step checkpoint (independent of the final successCheckpoint)", () => {
  const stepCheckpointCapability: CapabilityArtifact = {
    ...baseCapability,
    steps: [
      {
        id: "click-go",
        action: "click",
        classification: "safe",
        continuesAfterSkip: false,
        target: [role("button", "Go")],
        checkpoint: { kind: "heading_starts_with", text: "Member:" },
      },
      baseCapability.steps[1]!,
    ],
  };

  it("catches a wrong landing immediately, even though that page would satisfy the final successCheckpoint", async () => {
    const adapter = new FakeAdapter();
    // click-go lands on detailSnapshot ("Detail Page") — its heading starts with "Detail",
    // which WOULD satisfy the capability's overall successCheckpoint
    // ({ heading_starts_with: "Detail" }) — but click-go's own checkpoint requires
    // "Member:", so this must be caught right here, not silently reach read-value.
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot];

    const result = await replay(stepCheckpointCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("step_checkpoint_not_met");
      expect(result.stepId).toBe("click-go");
    }
    expect(result.steps[0]).toMatchObject({ stepId: "click-go", outcome: "failed" });
    expect(result.steps[1]).toMatchObject({ stepId: "read-value", outcome: "skipped" });
  });

  it("passes through cleanly when the step's own checkpoint is satisfied", async () => {
    const adapter = new FakeAdapter();
    const memberPage = snapshotOf('- \'heading "Member: Elena Cho" [level=1]\'', "http://localhost/detail");
    adapter.snapshotQueue = [loginSnapshot, memberPage, detailSnapshot];

    const result = await replay(stepCheckpointCapability, appProfile, adapter, {});

    expect(result.status).toBe("success");
  });
});

describe("replay — allowlist enforcement", () => {
  it("landing outside the allowlisted origin/routes is a failed result with errorClass allowlist_violation", async () => {
    const adapter = new FakeAdapter();
    const offSiteSnapshot = snapshotOf('- heading "Elsewhere" [level=1]', "http://evil.example/detail");
    adapter.snapshotQueue = [loginSnapshot, offSiteSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("allowlist_violation");
      expect(result.stepId).toBe("click-go");
    }
  });

  it("a route outside routePrefixes on the allowlisted origin is also a violation", async () => {
    const adapter = new FakeAdapter();
    const disallowedRouteSnapshot = snapshotOf('- heading "Admin" [level=1]', "http://localhost/admin");
    adapter.snapshotQueue = [loginSnapshot, disallowedRouteSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("allowlist_violation");
    }
  });
});

describe("replay — detection order (hard failure > business outcome > recovery > checkpoint)", () => {
  it("HTTP 5xx short-circuits to failed before any content is read", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot];
    adapter.navigationStatus = 200;

    // Flip status to 500 right when the post-click transition check runs.
    const originalClick = adapter.click.bind(adapter);
    adapter.click = async (...args) => {
      const r = await originalClick(...args);
      adapter.navigationStatus = 500;
      return r;
    };

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("http_error");
      expect(result.observed).toContain("500");
    }
  });

  it("business outcome short-circuits before the remaining steps run", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, notFoundSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("not_found");
    }
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.outcome).toBe("ok"); // click-go succeeded; the page it led to is the outcome
    expect(result.steps[1]!.outcome).toBe("skipped"); // read-value never ran
  });

  it("a recovery rule fires, is dismissed, and the run proceeds to a clean checkpoint", async () => {
    const adapter = new FakeAdapter();
    // entry check, then post-click check sees the interstitial, dismisses it (a click,
    // consuming no queue slot), re-checks and sees the real detail page, then the final
    // read+checkpoint check.
    adapter.snapshotQueue = [loginSnapshot, maintenanceSnapshot, detailSnapshot, detailSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("success");
    expect(result.recoveries).toEqual(["interstitial"]);
    expect(result.steps[0]!.recoveriesFired).toEqual(["interstitial"]);
  });

  it("checkpoint miss with no explanation is failed with full, redacted diagnostic detail (fix 2)", async () => {
    const adapter = new FakeAdapter();
    const wrongPage = snapshotOf('- heading "Something Else" [level=1]', "http://localhost/detail");
    adapter.snapshotQueue = [loginSnapshot, wrongPage, wrongPage];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("checkpoint_not_met");
      expect(result.stepId).toBe("read-value");
      expect(result.expected).toContain("heading_starts_with");
      // the actual heading IS reported as having been present, but never quoted raw
      expect(result.observed).toContain("a heading was present");
      expect(result.observed).not.toContain("Something Else");
      expect(result.observed).toContain("[REDACTED:pii]");
    }
  });

  it("a frame_present checkpoint miss reports which frames WERE seen instead", async () => {
    const frameCapability: CapabilityArtifact = {
      ...baseCapability,
      successCheckpoint: { kind: "frame_present", frame: { by: "title", value: "Missing Frame" } },
    };
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, detailSnapshot];

    const result = await replay(frameCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("checkpoint_not_met");
      expect(result.observed).toContain("frames seen");
      expect(result.observed).toContain("main");
    }
  });

  it("locator_not_found names which strategies were tried and their match counts", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot];
    adapter.shouldFailNextAction = true;

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("locator_not_found");
      expect(result.observed).toContain("strategies tried");
      expect(result.observed).toContain("role");
      expect(result.observed).toContain("0 matches");
    }
  });
});

describe("replay — session expiry", () => {
  it("does not false-positive while still on entryPoint before ever leaving it", async () => {
    // A capability whose first step doesn't navigate (e.g. typing) should not trip
    // the expiry check just because the current page is still entryPoint.
    const stationaryCapability: CapabilityArtifact = {
      ...baseCapability,
      inputs: { note: { type: "string", sensitivity: "none" } },
      steps: [
        {
          id: "type-note",
          action: "type",
          classification: "safe",
          continuesAfterSkip: false,
          target: [role("textbox", "Note")],
          value: { fromInput: "note" },
        },
        baseCapability.steps[1]!,
      ],
    };
    const adapter = new FakeAdapter();
    // Stays on /login for the type step, then moves to /detail for the read.
    adapter.snapshotQueue = [loginSnapshot, loginSnapshot, detailSnapshot, detailSnapshot];

    const result = await replay(stationaryCapability, appProfile, adapter, { note: "hi" });
    expect(result.status).toBe("success");
  });

  it("after a safe step, landing back on entryPoint is a failed result with errorClass session_expired", async () => {
    const adapter = new FakeAdapter();
    // entry: login (haven't left yet) -> click-go: detail (now we've left) ->
    // read-value: the app profile's expired-session page (matches sessionExpiry).
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, expiredLoginSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("session_expired");
      expect(result.stepId).toBe("read-value");
    }
  });

  it("a coincidental plain revisit to entryPoint (no expiry signal) is NOT misclassified as session_expired", async () => {
    // The old entryPoint-path-inference mechanism would have flagged this as expiry;
    // the app-profile-shape mechanism correctly requires the actual signal (the alert)
    // to be present, not just the bare fact of being back on the entry path.
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, loginSnapshot];

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).not.toBe("session_expired");
      expect(result.errorClass).toBe("checkpoint_not_met");
    }
  });
});

describe("replay — bounded recovery", () => {
  it("a recovery that never clears the condition fails with recovery_exhausted instead of looping forever", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot]; // entry check clean; every check after this sees maintenance
    adapter.snapshot = async () => maintenanceSnapshot; // always the interstitial, never clears

    const result = await replay(baseCapability, appProfile, adapter, {}, { recoveryLimits: { perRule: 2, overall: 10 } });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("recovery_exhausted");
    }
  });
});

describe("replay — irreversible steps (opt-in gate)", () => {
  // A safe leading step establishes "we've left entryPoint" before the irreversible
  // step runs — matching a real artifact's shape (login/navigation steps always come
  // first) and giving the session-expiry check something meaningful to compare against.
  const irreversibleCapability: CapabilityArtifact = {
    ...baseCapability,
    steps: [
      baseCapability.steps[0]!, // click-go (safe) — leaves entryPoint
      {
        id: "open-account",
        action: "click",
        classification: "irreversible",
        continuesAfterSkip: false,
        target: [role("button", "Open Account")],
      },
      baseCapability.steps[1]!, // read-value (last)
    ],
  };

  it("without allowIrreversible, stops before attempting and escalates with the step recorded as unauthorized", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot];

    const result = await replay(irreversibleCapability, appProfile, adapter, {});

    expect(result.status).toBe("escalated");
    expect(adapter.clickLog).toHaveLength(1); // only click-go — open-account was never sent
    expect(result.steps[0]).toMatchObject({ stepId: "click-go", outcome: "ok" });
    expect(result.steps[1]).toMatchObject({
      stepId: "open-account",
      outcome: "skipped",
      irreversibleExecutionAuthorized: false,
    });
    expect(result.steps[2]).toMatchObject({ stepId: "read-value", outcome: "skipped" });
  });

  it("with allowIrreversible, executes normally and proceeds to success on a clean result", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, detailSnapshot, detailSnapshot];

    const result = await replay(irreversibleCapability, appProfile, adapter, {}, { allowIrreversible: true });

    expect(result.status).toBe("success");
    expect(adapter.clickLog).toHaveLength(2); // click-go, then open-account — the action WAS sent
    expect(result.steps[1]).toMatchObject({
      stepId: "open-account",
      outcome: "ok",
      irreversibleExecutionAuthorized: true,
    });
  });

  it("with allowIrreversible, an ambiguous result (session expiry) after the action escalates and never retries", async () => {
    const adapter = new FakeAdapter();
    // entry: login -> click-go: detail (left entryPoint) -> open-account: the app
    // profile's expired-session page.
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, expiredLoginSnapshot];

    const result = await replay(irreversibleCapability, appProfile, adapter, {}, { allowIrreversible: true });

    expect(result.status).toBe("escalated");
    if (result.status === "escalated") {
      expect(result.reason).toContain("open-account");
      expect(result.reason.toLowerCase()).toContain("may already have taken place");
    }
    expect(adapter.clickLog).toHaveLength(2); // click-go once, open-account exactly once — never retried
    expect(result.steps[1]).toMatchObject({ stepId: "open-account", outcome: "failed", irreversibleExecutionAuthorized: true });
  });

  it("with allowIrreversible, a hard failure (HTTP 5xx) after the action also escalates, not fails", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot];
    let clickCount = 0;
    const originalClick = adapter.click.bind(adapter);
    adapter.click = async (...args) => {
      clickCount += 1;
      const r = await originalClick(...args);
      if (clickCount === 2) {
        // open-account's click specifically — click-go must stay clean so we've
        // genuinely left entryPoint before the irreversible step's own failure.
        adapter.navigationStatus = 500;
      }
      return r;
    };

    const result = await replay(irreversibleCapability, appProfile, adapter, {}, { allowIrreversible: true });

    expect(result.status).toBe("escalated");
    expect(adapter.clickLog).toHaveLength(2);
  });

  it("a locator failure on a SAFE step is a plain failed result (not escalated)", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot];
    adapter.shouldFailNextAction = true; // fails the click itself

    const result = await replay(baseCapability, appProfile, adapter, {});

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorClass).toBe("locator_not_found");
      expect(result.stepId).toBe("click-go");
    }
  });
});

describe("replay — redaction", () => {
  const capabilityWithSecret: CapabilityArtifact = {
    ...baseCapability,
    inputs: {
      password: { type: "string", sensitivity: "secret" },
      note: { type: "string", sensitivity: "none" },
    },
    steps: [
      {
        id: "type-password",
        action: "type",
        classification: "safe",
        continuesAfterSkip: false,
        target: [role("textbox", "Password")],
        value: { fromInput: "password" },
      },
      {
        id: "type-note",
        action: "type",
        classification: "safe",
        continuesAfterSkip: false,
        target: [role("textbox", "Note")],
        value: { fromInput: "note" },
      },
      baseCapability.steps[1]!,
    ],
  };

  it("never puts the literal secret value in the step record, even on a fully successful run", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, loginSnapshot, detailSnapshot, detailSnapshot];

    const result = await replay(capabilityWithSecret, appProfile, adapter, {
      password: "hunter2",
      note: "hello",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(result.steps[0]!.attemptedValue).toBe("[REDACTED:secret]");
    expect(result.steps[1]!.attemptedValue).toBe("hello");
  });

  it("never puts the literal secret value in a failed result's diagnostic fields", async () => {
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, loginSnapshot];
    adapter.shouldFailNextAction = true; // fail the password type step itself

    const result = await replay(capabilityWithSecret, appProfile, adapter, {
      password: "hunter2",
      note: "hello",
    });

    expect(result.status).toBe("failed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hunter2");
    expect(result.steps[0]!.attemptedValue).toBe("[REDACTED:secret]");
  });

  it("a value read off the page stays unredacted in the success result's outputs, but redacted in the step record (fix 1)", async () => {
    const capabilityWithPiiOutput: CapabilityArtifact = {
      ...baseCapability,
      outputs: { value: { type: "string", sensitivity: "pii" } },
    };
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, detailSnapshot];
    adapter.readValue = "Elena Cho";

    const result = await replay(capabilityWithPiiOutput, appProfile, adapter, {});

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.value).toBe("Elena Cho"); // unredacted — this is what the caller asked for
    }
    expect(result.steps[1]!.observedValue).toBe("[REDACTED:pii]"); // redacted everywhere else
    expect(JSON.stringify(result.steps)).not.toContain("Elena Cho");
  });
});

describe("replay — input validation (decision 7: permissive by construction)", () => {
  it("throws for a missing declared input on a capability that has one", async () => {
    const capabilityWithInput: CapabilityArtifact = {
      ...baseCapability,
      inputs: { memberId: { type: "string", sensitivity: "pii" } },
    };
    const adapter = new FakeAdapter();
    await expect(replay(capabilityWithInput, appProfile, adapter, {})).rejects.toThrow();
  });

  it("does not throw for a non-numeric, empty-typed-but-present input — the app decides, not the schema", async () => {
    const capabilityWithInput: CapabilityArtifact = {
      ...baseCapability,
      inputs: { memberId: { type: "string", sensitivity: "pii" } },
    };
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [loginSnapshot, detailSnapshot, detailSnapshot];
    await expect(replay(capabilityWithInput, appProfile, adapter, { memberId: "" })).resolves.toBeDefined();
  });
});
