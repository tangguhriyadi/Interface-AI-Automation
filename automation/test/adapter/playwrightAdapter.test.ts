import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../adapter/playwrightAdapter.js";
import { resolveRef, type SnapshotNode } from "../../adapter/snapshotParser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function findNode(nodes: SnapshotNode[], role: string, name: string): SnapshotNode {
  for (const node of nodes) {
    if (node.role === role && node.name === name) {
      return node;
    }
    const found = findNode(node.children, role, name);
    if (found) {
      return found;
    }
  }
  throw new Error(`No ${role} "${name}" found in snapshot`);
}

describe("PlaywrightAdapter — local fixtures, no target-app", () => {
  let adapter: PlaywrightAdapter;

  beforeAll(async () => {
    adapter = await PlaywrightAdapter.launch(`file://${fixturesDir}`);
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("falls through the locator chain when the primary strategy doesn't match", async () => {
    await adapter.goto("/adapter-page.html");
    const result = await adapter.click([
      { kind: "role", role: "button", name: "Submit", exact: true, rationale: "wrong on purpose" },
      { kind: "css", selector: "#save-btn", brittle: true, rationale: "fallback" },
    ]);
    expect(result.matchedStrategy.kind).toBe("css");
  });

  it("resolves a structural locator via the row-header cell", async () => {
    await adapter.goto("/adapter-page.html");
    const result = await adapter.read([
      { kind: "structural", description: "row-header cell", rowHeader: "Savings", rationale: "only distinguishing signal" },
    ]);
    expect(result.value).toBe("$1,234.56");
    expect(result.matchedStrategy.kind).toBe("structural");
  });

  it("resolves a label locator", async () => {
    await adapter.goto("/adapter-page.html");
    const result = await adapter.type(
      [{ kind: "label", text: "Notes", exact: true, rationale: "labeled input" }],
      "hello",
    );
    expect(result.matchedStrategy.kind).toBe("label");
  });

  it("targets an iframe by title", async () => {
    await adapter.goto("/adapter-frame-parent.html");
    const result = await adapter.click(
      [{ kind: "role", role: "button", name: "Inner Button", exact: true, rationale: "only button in the frame" }],
      { by: "title", value: "Content Frame" },
    );
    expect(result.matchedStrategy.kind).toBe("role");
  });

  it("throws a clear error when no strategy in the chain resolves uniquely", async () => {
    await adapter.goto("/adapter-page.html");
    await expect(
      adapter.click([{ kind: "css", selector: "#does-not-exist", brittle: true, rationale: "x" }]),
    ).rejects.toThrow(/No locator strategy in the chain resolved/);
  });

  it("snapshot + resolveRef round-trip: a ref resolved back into a locator hits the same element", async () => {
    await adapter.goto("/adapter-page.html");
    const snapshot = await adapter.snapshot();
    const mainFrame = snapshot.frames.find((f) => f.frameId === "main");
    expect(mainFrame).toBeDefined();
    const buttonNode = findNode(mainFrame!.nodes, "button", "Save");

    const chain = resolveRef(snapshot, "main", buttonNode.ref);
    const result = await adapter.click(chain);
    expect(result.matchedStrategy.kind).toBe("role");
  });
});
