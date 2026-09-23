import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrameSnapshot, type Snapshot } from "../../adapter/snapshotParser.js";
import { buildCompactView, redactSecretValuesInView, refKey } from "../../discovery/compactView.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

function snapshotFor(yaml: string, frame: { frameId?: string; title?: string; name?: string; url?: string } = {}): Snapshot {
  return {
    frames: [
      parseFrameSnapshot(yaml, {
        frameId: frame.frameId ?? "main",
        url: frame.url ?? "http://localhost/x",
        ...(frame.title !== undefined ? { title: frame.title } : {}),
        ...(frame.name !== undefined ? { name: frame.name } : {}),
      }),
    ],
  };
}

describe("buildCompactView — real captured login page", () => {
  const snapshot = snapshotFor(readFixture("login-page.aria.yaml"));
  const view = buildCompactView(snapshot);
  const nodes = view.frames[0]!.nodes;

  it("includes interactive textboxes and the submit button", () => {
    expect(nodes.some((n) => n.role === "textbox" && n.name === "Username")).toBe(true);
    expect(nodes.some((n) => n.role === "textbox" && n.name === "Password")).toBe(true);
    expect(nodes.some((n) => n.role === "button" && n.name === "Log In")).toBe(true);
  });

  it("includes readable labels (cells) but excludes the pure structural containers", () => {
    expect(nodes.some((n) => n.role === "cell" && n.name === "Username")).toBe(true);
    expect(nodes.some((n) => n.role === "heading" && n.name === "Log In")).toBe(true);
    expect(nodes.some((n) => n.role === "table")).toBe(false);
    expect(nodes.some((n) => n.role === "rowgroup")).toBe(false);
    expect(nodes.some((n) => n.role === "row")).toBe(false);
  });

  it("excludes a wrapper cell whose name is just the concatenation of its own children's text (verified live: a filled version of this same cell reads \"Username teller Password local-dev-only Log In\")", () => {
    expect(nodes.some((n) => n.role === "cell" && n.name === "Username Password Log In")).toBe(false);
  });

  it("marks the main frame with no `frame` field", () => {
    expect(view.frames[0]!.frame).toBeUndefined();
  });

  it("every node carries the owning frameId", () => {
    expect(nodes.every((n) => n.frameId === "main")).toBe(true);
  });
});

describe("buildCompactView — real captured balance panel (sub-frame + row headers)", () => {
  const snapshot = snapshotFor(readFixture("balance-panel.aria.yaml"), {
    frameId: "iframe:Account Balance",
    title: "Account Balance",
  });
  const view = buildCompactView(snapshot);
  const frameView = view.frames[0]!;

  it("describes the sub-frame by its title", () => {
    expect(frameView.frame).toEqual({ by: "title", value: "Account Balance" });
  });

  it("surfaces the row-header hint on each value cell, even though the cell also has its own accessible name", () => {
    const savingsCell = frameView.nodes.find((n) => n.role === "cell" && n.name === "$1,234.56");
    expect(savingsCell?.rowHeader).toBe("Savings");
    const checkingCell = frameView.nodes.find((n) => n.role === "cell" && n.name === "$456.78");
    expect(checkingCell?.rowHeader).toBe("Checking");
  });

  it("does not attach a row-header hint to the rowheader node itself", () => {
    const rowHeaderNode = frameView.nodes.find((n) => n.role === "rowheader" && n.name === "Savings");
    expect(rowHeaderNode?.rowHeader).toBeUndefined();
  });

  it("excludes table/rowgroup/row containers here too", () => {
    expect(frameView.nodes.some((n) => n.role === "row")).toBe(false);
  });
});

describe("buildCompactView — Actions-column pattern: a cell wrapping exactly one leaf control", () => {
  // Two rows, each a rowheader (the member's name) plus a cell wrapping a single "View"
  // link — the same shape a table-heavy legacy app's Actions column takes. Both links
  // share the same accessible name, so the row header is the only thing distinguishing them.
  const yaml = [
    '- row "Elena Cho View":',
    '  - rowheader "Elena Cho"',
    '  - cell "View":',
    '    - link "View"',
    '- row "Marcus Webb View":',
    '  - rowheader "Marcus Webb"',
    '  - cell "View":',
    '    - link "View"',
  ].join("\n");
  const snapshot = snapshotFor(yaml);
  const view = buildCompactView(snapshot);
  const nodes = view.frames[0]!.nodes;
  const viewLinks = nodes.filter((n) => n.role === "link" && n.name === "View");

  it("does not drop the wrapping cell (it wraps exactly one leaf control, not structure)", () => {
    expect(nodes.some((n) => n.role === "cell")).toBe(true);
  });

  it("surfaces both same-named links, each distinguished by its own row's header", () => {
    expect(viewLinks).toHaveLength(2);
    expect(viewLinks.map((l) => l.rowHeader)).toEqual(["Elena Cho", "Marcus Webb"]);
  });
});

describe("buildCompactView — a cell wrapping more than one leaf control is still excluded", () => {
  it("drops a cell containing two leaf controls (e.g. 'Edit' and 'Delete' in one Actions cell) — no single row-header hint could tell them apart", () => {
    const yaml = [
      '- row "Elena Cho Edit Delete":',
      '  - rowheader "Elena Cho"',
      '  - cell "Edit Delete":',
      '    - link "Edit"',
      '    - link "Delete"',
    ].join("\n");
    const snapshot = snapshotFor(yaml);
    const view = buildCompactView(snapshot);
    const nodes = view.frames[0]!.nodes;
    expect(nodes.some((n) => n.role === "cell" && n.name === "Edit Delete")).toBe(false);
    // The individual leaf controls still surface via recursion, each correctly hinted.
    expect(nodes.find((n) => n.role === "link" && n.name === "Edit")?.rowHeader).toBe("Elena Cho");
    expect(nodes.find((n) => n.role === "link" && n.name === "Delete")?.rowHeader).toBe("Elena Cho");
  });
});

describe("buildCompactView — redaction of a typed secret value", () => {
  it("redacts a filled password field's value when its ref is marked redacted, leaving the name visible", () => {
    const yaml = '- textbox "Password": secretpass\n';
    const snapshot = snapshotFor(yaml);
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const view = buildCompactView(snapshot, { redactedRefs: new Set([refKey("main", ref)]) });
    const node = view.frames[0]!.nodes[0]!;
    expect(node.name).toBe("Password");
    expect(node.value).toBe("[REDACTED:secret]");
    expect(JSON.stringify(view)).not.toContain("secretpass");
  });

  it("leaves a pii-sensitivity typed value (e.g. a searched memberId) visible — not in redactedRefs", () => {
    const yaml = '- textbox "Member ID": 10001\n';
    const snapshot = snapshotFor(yaml);
    const view = buildCompactView(snapshot); // no redactedRefs supplied
    expect(view.frames[0]!.nodes[0]!.value).toBe("10001");
  });

  it("only redacts the specific ref marked, not every filled field", () => {
    const yaml = '- textbox "Username": someuser\n' + '- textbox "Password": secretpass\n';
    const snapshot = snapshotFor(yaml);
    const [usernameRef, passwordRef] = snapshot.frames[0]!.nodes.map((n) => n.ref);
    const view = buildCompactView(snapshot, { redactedRefs: new Set([refKey("main", passwordRef!)]) });
    const [usernameNode, passwordNode] = view.frames[0]!.nodes;
    expect(usernameNode!.value).toBe("someuser");
    expect(usernameRef).not.toBe(passwordRef);
    expect(passwordNode!.value).toBe("[REDACTED:secret]");
  });
});

describe("buildCompactView — refs stay frame-scoped", () => {
  it("two frames whose parser assigns the same ref string are kept distinct via frameId, not merged", () => {
    const mainFrame = parseFrameSnapshot('- button "Search"\n', { frameId: "main", url: "http://localhost/x" });
    const subFrame = parseFrameSnapshot('- button "Dismiss"\n', {
      frameId: "iframe:Modal",
      name: "Modal",
      url: "http://localhost/x",
    });
    // Both frames' first (and only) node gets ref "0" from the parser's own per-frame counter.
    expect(mainFrame.nodes[0]!.ref).toBe(subFrame.nodes[0]!.ref);

    const view = buildCompactView({ frames: [mainFrame, subFrame] });
    const mainNode = view.frames[0]!.nodes[0]!;
    const subNode = view.frames[1]!.nodes[0]!;
    expect(mainNode.ref).toBe(subNode.ref);
    expect(mainNode.frameId).toBe("main");
    expect(subNode.frameId).toBe("iframe:Modal");
    expect(mainNode.name).toBe("Search");
    expect(subNode.name).toBe("Dismiss");
  });
});

describe("buildCompactView — interactive elements with no name are still surfaced", () => {
  it("includes a nameless button as a ref the model can still point at", () => {
    const snapshot = snapshotFor("- button\n");
    const view = buildCompactView(snapshot);
    expect(view.frames[0]!.nodes).toHaveLength(1);
    expect(view.frames[0]!.nodes[0]).toMatchObject({ role: "button" });
    expect(view.frames[0]!.nodes[0]!.name).toBeUndefined();
  });

  it("excludes a non-interactive, unnamed, textless node (e.g. a bare iframe placeholder)", () => {
    const snapshot = snapshotFor("- iframe\n");
    const view = buildCompactView(snapshot);
    expect(view.frames[0]!.nodes).toHaveLength(0);
  });
});

describe("redactSecretValuesInView — the second, value-based redaction layer", () => {
  it("scrubs a secret value found in a field ref-based redaction never marked", () => {
    // Simulates the app echoing a typed password back in an unrelated alert — the exact
    // case ref-based redaction (CompactViewOptions.redactedRefs) can't cover, since nothing
    // marked *this* ref as holding the secret.
    const snapshot = snapshotFor('- alert: Invalid credentials for password "local-dev-only"\n');
    const view = buildCompactView(snapshot); // no redactedRefs — ref-based layer never fires
    const scrubbed = redactSecretValuesInView(view, ["local-dev-only"]);
    expect(JSON.stringify(scrubbed)).not.toContain("local-dev-only");
    expect(scrubbed.frames[0]!.nodes[0]!.value).toContain("[REDACTED:secret]");
  });

  it("scrubs a secret value out of a node's name, not just its value", () => {
    const snapshot = snapshotFor('- link "Reset local-dev-only"\n');
    const view = buildCompactView(snapshot);
    const scrubbed = redactSecretValuesInView(view, ["local-dev-only"]);
    expect(scrubbed.frames[0]!.nodes[0]!.name).toBe("Reset [REDACTED:secret]");
  });

  it("scrubs a secret value out of the frame description", () => {
    const snapshot = snapshotFor("- heading \"x\"\n", { frameId: "iframe:x", name: "session-local-dev-only" });
    const view = buildCompactView(snapshot);
    const scrubbed = redactSecretValuesInView(view, ["local-dev-only"]);
    expect(scrubbed.frames[0]!.frame).toEqual({ by: "name", value: "session-[REDACTED:secret]" });
  });

  it("acts as a genuine second layer: still catches the value even when ref-based redaction already fired on the same field", () => {
    const snapshot = snapshotFor('- textbox "Password": local-dev-only\n');
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const view = buildCompactView(snapshot, { redactedRefs: new Set([refKey("main", ref)]) });
    expect(view.frames[0]!.nodes[0]!.value).toBe("[REDACTED:secret]"); // already redacted by layer one
    const scrubbed = redactSecretValuesInView(view, ["local-dev-only"]);
    expect(scrubbed.frames[0]!.nodes[0]!.value).toBe("[REDACTED:secret]"); // layer two is a no-op here, not a double-marker
  });

  it("leaves the view unchanged (same shape) when no secret values are given", () => {
    const snapshot = snapshotFor('- button "Search"\n');
    const view = buildCompactView(snapshot);
    expect(redactSecretValuesInView(view, [])).toEqual(view);
  });
});
