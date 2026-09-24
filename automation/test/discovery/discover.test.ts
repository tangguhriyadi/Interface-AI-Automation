import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../adapter/snapshotParser.js";
import type { AppProfile } from "../../schema/appProfile.js";
import { discover, type DiscoveryGoal } from "../../discovery/discover.js";
import type { DiscoveryContext, DiscoveryModel, ModelTurn } from "../../discovery/model.js";
import { FakeAdapter, snapshotOf } from "../support/fakeAdapter.js";
import { FakeModel } from "../support/fakeModel.js";

const ENTRY_URL = "http://localhost/start";

/** `snapshotOf` with an absolute URL matching `baseGoal.entryPoint`'s origin — required now that discover() parses `mainFrame.url` for its own entryPoint/hasLeftEntryPoint tracking (same as replay()). */
function snapshotAt(yaml: string): Snapshot {
  return snapshotOf(yaml, ENTRY_URL);
}

function refOf(snapshot: Snapshot, role: string, name?: string): string {
  const frame = snapshot.frames[0]!;
  const walk = (nodes: typeof frame.nodes): string | undefined => {
    for (const node of nodes) {
      if (node.role === role && (name === undefined || node.name === name)) {
        return node.ref;
      }
      const found = walk(node.children);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  const ref = walk(frame.nodes);
  if (ref === undefined) {
    throw new Error(`No ${role} "${name ?? ""}" node in fixture snapshot — fix the test fixture.`);
  }
  return ref;
}

const baseAppProfile: AppProfile = {
  schemaVersion: "1.0.0",
  appId: "test-app",
  outcomes: {},
  recoveries: [],
  irreversibleControls: [],
  allowlist: { originPattern: "http://localhost", routePrefixes: ["/"] },
};

const baseGoal: DiscoveryGoal = {
  capabilityId: "test_capability",
  version: "1.0.0",
  appId: "test-app",
  description: "Search for a term and read whether it was found.",
  entryPoint: "/start",
  inputs: { searchTerm: { value: "10001", sensitivity: "pii" } },
  outputs: { result: { sensitivity: "pii" } },
};

describe("discover — happy path to done", () => {
  it("types the declared input, clicks, reads the declared output, then accepts done — capability is draft, every step is safe", async () => {
    const page1 = snapshotAt('- textbox "Search"\n- button "Go"\n');
    const page2 = snapshotAt('- textbox "Search": 10001\n- button "Go"\n');
    const page3 = snapshotAt("- 'heading \"Results: 10001\" [level=1]'\n- cell \"Found\"\n");

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page1, page2, page3, page3]; // page3 twice: once for the read decision, once as the fresh re-check `done` performs
    adapter.readValue = "Found";

    const model = new FakeModel();
    const turns: ModelTurn[] = [
      { kind: "tool_call", call: { tool: "type", args: { frameId: "main", ref: refOf(page1, "textbox", "Search"), inputName: "searchTerm" } } },
      { kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(page2, "button", "Go") } } },
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page3, "cell", "Found"), outputName: "result" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page3, "heading") } } } },
    ];
    model.turnQueue = turns;

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("done");
    if (result.status === "done") {
      expect(result.capability.approvalState).toBe("draft");
      expect(result.capability.successCheckpoint).toEqual({ kind: "heading_starts_with", text: "Results:" });
      expect(result.capability.steps.every((s) => s.classification === "safe")).toBe(true);
      expect(result.capability.steps.map((s) => s.action)).toEqual(["type", "click", "read"]);
      const typeStep = result.capability.steps[0];
      if (typeStep?.action === "type") {
        expect(typeStep.value).toEqual({ fromInput: "searchTerm" }); // never a literal
      }
    }
  });
});

describe("discover — done refused for a declared output still unwritten, then a retry succeeds", () => {
  it("refuses done before the read happens, and accepts it after", async () => {
    const page1 = snapshotAt("- 'heading \"Results: 10001\" [level=1]'\n- cell \"Found\"\n");

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page1, page1, page1, page1]; // decision, decision, decision+fresh-recheck
    adapter.readValue = "Found";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page1, "heading") } } } }, // refused: result unwritten
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page1, "cell", "Found"), outputName: "result" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page1, "heading") } } } }, // now succeeds
    ];

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("done");
    expect(result.turns.some((t) => t.toolName === "done" && t.outcome === "refused" && /unwritten|not.*written/i.test(t.detail))).toBe(
      true,
    );
  });
});

describe("discover — done refused when the derived checkpoint isn't true against a fresh re-check, then a retry succeeds", () => {
  it("re-verifies against a freshly-taken snapshot immediately before accepting — catching drift since the proof was chosen", async () => {
    // The model reads the output on a settled page, then points `done` at a heading that
    // read one value at decision time but the driver's fresh re-check (a second, independent
    // snapshot call right before accepting) finds the page has since changed underneath it.
    const settled = snapshotAt("- 'heading \"Results: 10001\" [level=1]'\n- cell \"Found\"\n");
    const changedUnderneath = snapshotAt('- heading "Loading" [level=1]\n- cell "Found"\n');

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [settled, settled, changedUnderneath, settled, settled];
    adapter.readValue = "Found";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(settled, "cell", "Found"), outputName: "result" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(settled, "heading") } } } }, // refused: fresh re-check shows "Loading"
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(settled, "heading") } } } }, // now succeeds
    ];

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("done");
    expect(
      result.turns.some((t) => t.toolName === "done" && t.outcome === "refused" && /not true|checkpoint/i.test(t.detail)),
    ).toBe(true);
  });
});

describe("discover — an irreversible-control click is refused, never executed; the model escalates", () => {
  it("never calls adapter.click for the irreversible control, and returns escalated with the model's reason", async () => {
    const page = snapshotAt('- button "Delete Account"\n');
    const profile: AppProfile = {
      ...baseAppProfile,
      irreversibleControls: [{ role: "button", name: "Delete Account", exact: true }],
    };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page];

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(page, "button", "Delete Account") } } },
      { kind: "tool_call", call: { tool: "escalate", args: { reasonCode: "action_refused_irreversible" } } },
    ];

    const result = await discover(baseGoal, profile, adapter, model);

    expect(result.status).toBe("escalated");
    if (result.status === "escalated") {
      // Composed by the system from facts it already holds — never free text from the
      // model, so it necessarily includes the reason code and the refusal it followed.
      expect(result.reason).toContain("reasonCode=action_refused_irreversible");
      expect(result.reason).toContain("irreversible");
    }
    expect(adapter.clickLog).toHaveLength(0);
    expect(result.turns.some((t) => t.toolName === "click" && t.outcome === "refused" && /irreversible/i.test(t.detail))).toBe(
      true,
    );
  });
});

describe("discover — dead_end: several actions in a row with no change in the snapshot", () => {
  it("stops with dead_end once the no-op streak reaches the threshold, without ever reaching max_steps", async () => {
    const page = snapshotAt('- button "Refresh"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page]; // repeats forever — every action is a structural no-op

    const model = new FakeModel();
    // Queue more turns than the default dead-end threshold (3) needs — dead_end should stop it first.
    for (let i = 0; i < 10; i++) {
      model.turnQueue.push({ kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(page, "button") } } });
    }

    const result = await discover(baseGoal, baseAppProfile, adapter, model, { deadEndThreshold: 3, maxSteps: 25 });

    expect(result.status).toBe("dead_end");
  });

  it("does NOT trigger on several consecutive successful reads, even though a read never changes the page by design", async () => {
    // Live-discovered bug: a read is never supposed to mutate the page, so three reads in a
    // row on the same settled page — an entirely ordinary way to finish a goal with three
    // declared outputs — looked structurally identical to the model being stuck. Real
    // progress is "the snapshot changed" OR "a new output got written," not just the first.
    const page = snapshotAt('- heading "Report" [level=1]\n- cell "AlphaValue"\n- cell "BetaValue"\n- cell "GammaValue"\n');
    const goal: DiscoveryGoal = {
      ...baseGoal,
      outputs: { a: { sensitivity: "none" }, b: { sensitivity: "none" }, c: { sensitivity: "none" } },
    };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page]; // the exact same page for every single iteration
    adapter.readValue = "same-value-every-time";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page, "cell", "AlphaValue"), outputName: "a" } } },
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page, "cell", "BetaValue"), outputName: "b" } } },
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page, "cell", "GammaValue"), outputName: "c" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page, "heading") } } } },
    ];

    const result = await discover(goal, baseAppProfile, adapter, model, { deadEndThreshold: 3 });

    expect(result.status).toBe("done");
  });
});

describe("discover — max_steps", () => {
  it("stops as soon as the step budget is exhausted, without calling the model again", async () => {
    const page1 = snapshotAt('- button "A"\n');
    const page2 = snapshotAt('- button "B"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page1, page2];

    const model = new FakeModel();
    model.turnQueue = [{ kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(page1, "button", "A") } } }];

    const result = await discover(baseGoal, baseAppProfile, adapter, model, { maxSteps: 1 });

    expect(result.status).toBe("max_steps");
    if (result.status === "max_steps") {
      expect(result.stepsTaken).toBe(1);
    }
    expect(model.contextsSeen).toHaveLength(1); // the model was never asked for a second turn
  });
});

describe("discover — timeout", () => {
  it("stops immediately when the time budget is already exhausted, without calling the model", async () => {
    const page = snapshotAt('- button "A"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page];
    const model = new FakeModel(); // no turns queued — a call would throw

    const result = await discover(baseGoal, baseAppProfile, adapter, model, { timeoutMs: 0 });

    expect(result.status).toBe("timeout");
    expect(model.contextsSeen).toHaveLength(0);
  });
});

describe("discover — escalated (direct)", () => {
  it("stops immediately on the model's own escalate call", async () => {
    const page = snapshotAt('- button "A"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page];
    const model = new FakeModel();
    model.turnQueue = [{ kind: "tool_call", call: { tool: "escalate", args: { reasonCode: "stuck" } } }];

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("escalated");
    if (result.status === "escalated") {
      expect(result.reason).toContain("reasonCode=stuck");
      // The very first turn — no prior action to report, and the composer handles that gracefully.
      expect(result.reason).not.toContain("lastAction");
    }
  });
});

describe("discover — a mid-run business outcome ends discovery with its own distinct result", () => {
  it("stops with business_outcome the moment a declared app-profile outcome matches, without waiting for dead_end", async () => {
    const searchPage = snapshotAt('- textbox "Search"\n- button "Go"\n');
    const notFoundPage = snapshotAt('- heading "Not Found" [level=1]\n');

    const profile: AppProfile = {
      ...baseAppProfile,
      outcomes: { not_found: { name: "not_found", shapes: [{ headingEquals: "Not Found" }] } },
    };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [searchPage, notFoundPage];

    const model = new FakeModel();
    model.turnQueue = [{ kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(searchPage, "button", "Go") } } }];

    const result = await discover(baseGoal, profile, adapter, model);

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("not_found");
    }
    // The model was never shown the Not Found page at all — discovery stopped before
    // building a compact view for it, let alone letting the model flail against it.
    expect(model.contextsSeen).toHaveLength(1);
  });
});

describe("discover — session expiry mid-run ends discovery with its own distinct result", () => {
  it("stops with session_expired once the app profile's signal matches, after having left entryPoint", async () => {
    const detailPage = snapshotOf('- heading "Detail" [level=1]\n- button "Refresh"\n', "http://localhost/detail");
    const expiredPage = snapshotOf(
      '- heading "Log In" [level=1]\n- alert: Your session expired. Please log in again.\n',
      "http://localhost/detail",
    );

    const profile: AppProfile = {
      ...baseAppProfile,
      sessionExpiry: [{ headingEquals: "Log In", roleAlertContains: "session expired" }],
    };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [detailPage, expiredPage];

    const model = new FakeModel();
    model.turnQueue = [{ kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(detailPage, "button", "Refresh") } } }];

    const result = await discover(baseGoal, profile, adapter, model);

    expect(result.status).toBe("session_expired");
    expect(model.contextsSeen).toHaveLength(1);
  });
});

describe("discover — a recoverable interstitial is dismissed by the loop, invisibly", () => {
  it("dismisses it before the compact view is built, records it in result.recoveries, and it never becomes a step", async () => {
    const interstitial = snapshotAt('- heading "System Maintenance" [level=1]\n- button "Dismiss"\n');
    const settledSearchPage = snapshotAt('- textbox "Search"\n- button "Go"\n');
    const resultsPage = snapshotAt("- 'heading \"Results: 10001\" [level=1]'\n- cell \"Found\"\n");

    const profile: AppProfile = {
      ...baseAppProfile,
      recoveries: [
        {
          name: "maintenance_interstitial",
          detect: [{ headingEquals: "System Maintenance" }],
          action: {
            kind: "dismiss",
            locator: [{ kind: "role", role: "button", name: "Dismiss", exact: true, rationale: "the only control" }],
          },
        },
      ],
    };

    const adapter = new FakeAdapter();
    // Iteration 1: detect() sees the interstitial, dismisses it (adapter.click, NOT a
    // model-chosen action), re-snapshots -> settledSearchPage is what the model is shown.
    adapter.snapshotQueue = [interstitial, settledSearchPage, resultsPage, resultsPage];
    adapter.readValue = "Found";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(settledSearchPage, "button", "Go") } } },
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(resultsPage, "cell", "Found"), outputName: "result" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(resultsPage, "heading") } } } },
    ];

    const result = await discover(baseGoal, profile, adapter, model);

    expect(result.recoveries).toEqual(["maintenance_interstitial"]);
    // The model's very first compact view is the settled page, post-dismiss — it never saw
    // the interstitial and so never had the chance to dismiss it itself.
    expect(JSON.stringify(model.contextsSeen[0]!.compactSnapshot)).not.toContain("System Maintenance");
    expect(result.status).toBe("done");
    if (result.status === "done") {
      // Exactly the model's own two actions — click and read — never a third step for the dismiss.
      expect(result.capability.steps.map((s) => s.action)).toEqual(["click", "read"]);
    }
  });
});

describe("discover — the checkpoint safety net only blocks values long enough to plausibly identify something", () => {
  it("does not refuse done over a short, incidentally generic read value (e.g. a status word)", async () => {
    // "active" (6 chars) is below the minimum scrub-pattern length — reading it as a pii
    // output must not then block any checkpoint text that happens to contain that common word.
    const page = snapshotAt('- heading "active" [level=1]\n- cell "active"\n');
    const goal: DiscoveryGoal = { ...baseGoal, outputs: { status: { sensitivity: "pii" } } };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page, page];
    adapter.readValue = "active";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page, "cell"), outputName: "status" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page, "heading") } } } },
    ];

    const result = await discover(goal, baseAppProfile, adapter, model);

    expect(result.status).toBe("done"); // not refused — "active" is too short to count as a scrub pattern
  });

  it("still refuses done over a long, genuinely identifying read value (e.g. a member's name)", async () => {
    const page = snapshotAt("- 'heading \"Confirmed Elena Cho\" [level=1]'\n- cell \"Elena Cho\"\n");
    const goal: DiscoveryGoal = { ...baseGoal, outputs: { memberName: { sensitivity: "pii" } } };

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page, page, page];
    adapter.readValue = "Elena Cho";

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "read", args: { frameId: "main", ref: refOf(page, "cell"), outputName: "memberName" } } },
      { kind: "tool_call", call: { tool: "done", args: { proof: { frameId: "main", ref: refOf(page, "heading") } } } }, // refused
      { kind: "tool_call", call: { tool: "escalate", args: { reasonCode: "cannot_complete" } } },
    ];

    const result = await discover(goal, baseAppProfile, adapter, model);

    expect(
      result.turns.some((t) => t.toolName === "done" && t.outcome === "refused" && /secret|pii|sensitive/i.test(t.detail)),
    ).toBe(true);
    expect(result.status).toBe("escalated");
  });
});

/** A DiscoveryModel whose chooseNextAction never resolves — simulates a hung API call. */
class HangingModel implements DiscoveryModel {
  async chooseNextAction(_context: DiscoveryContext): Promise<ModelTurn> {
    return new Promise(() => {}); // deliberately never settles
  }
}

describe("discover — a hung model call is bounded by the remaining timeout budget", () => {
  it("stops with timeout instead of hanging forever, even though the model call itself never resolves", async () => {
    const page = snapshotAt('- button "A"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page];

    const result = await discover(baseGoal, baseAppProfile, adapter, new HangingModel(), { timeoutMs: 30 });

    expect(result.status).toBe("timeout");
  });
});

describe("discover — an off-allowlist navigation ends discovery with allowlist_violation", () => {
  it("stops the moment a model-chosen click lands the main frame outside the allowlist, before it could ever be recorded as a step", async () => {
    const page1 = snapshotAt('- link "Somewhere else"\n');
    const offAllowlistPage = snapshotOf('- heading "Elsewhere" [level=1]\n', "http://evil.example/start");

    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page1, offAllowlistPage];

    const model = new FakeModel();
    model.turnQueue = [
      { kind: "tool_call", call: { tool: "click", args: { frameId: "main", ref: refOf(page1, "link", "Somewhere else") } } },
    ];

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("allowlist_violation");
    if (result.status === "allowlist_violation") {
      expect(result.url).toBe("http://evil.example/start");
    }
    // Discovery stopped as soon as it saw the off-allowlist page — never asked the model
    // what to do next, so there was no chance for a step to be recorded off the back of it.
    expect(model.contextsSeen).toHaveLength(1);
  });
});

describe("discover — a hard HTTP failure (5xx) ends discovery with http_error", () => {
  it("stops before reading any page content, the same as replay()", async () => {
    const page = snapshotAt('- button "A"\n');
    const adapter = new FakeAdapter();
    adapter.snapshotQueue = [page];
    adapter.navigationStatus = 502;

    const model = new FakeModel(); // never called — the hard-failure check runs before the model does

    const result = await discover(baseGoal, baseAppProfile, adapter, model);

    expect(result.status).toBe("http_error");
    if (result.status === "http_error") {
      expect(result.httpStatus).toBe(502);
    }
    expect(model.contextsSeen).toHaveLength(0);
  });
});
