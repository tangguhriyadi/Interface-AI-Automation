import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrameSnapshot, resolveRef, type Snapshot } from "../../adapter/snapshotParser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

function findAll(nodes: ReturnType<typeof parseFrameSnapshot>["nodes"], role: string): { role: string; name?: string }[] {
  const out: { role: string; name?: string }[] = [];
  const walk = (list: typeof nodes) => {
    for (const node of list) {
      if (node.role === role) {
        out.push({ role: node.role, ...(node.name !== undefined ? { name: node.name } : {}) });
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

describe("parseFrameSnapshot — real captured target-app YAML", () => {
  it("parses the login page: two textboxes, a submit button, no accessible-name loss", () => {
    const frame = parseFrameSnapshot(readFixture("login-page.aria.yaml"), { frameId: "main", url: "/login" });
    const textboxes = findAll(frame.nodes, "textbox");
    expect(textboxes.map((n) => n.name)).toEqual(["Username", "Password"]);
    expect(findAll(frame.nodes, "button").map((n) => n.name)).toEqual(["Log In"]);
  });

  it("parses the member detail page: rowheaders present, and a heading whose name contains a colon survives YAML's single-quote escaping", () => {
    const frame = parseFrameSnapshot(readFixture("member-detail-page.aria.yaml"), {
      frameId: "main",
      url: "/members/10001",
    });
    const rowheaders = findAll(frame.nodes, "rowheader").map((n) => n.name);
    expect(rowheaders).toEqual(["Name", "Member ID", "Status"]);

    const heading = findAll(frame.nodes, "heading")[0];
    expect(heading?.name).toBe("Member: Elena Cho");
  });

  it("parses the member detail page's bare iframe node with no accessible name", () => {
    const frame = parseFrameSnapshot(readFixture("member-detail-page.aria.yaml"), {
      frameId: "main",
      url: "/members/10001",
    });
    const iframeNode = findAll(frame.nodes, "iframe")[0];
    expect(iframeNode).toBeDefined();
    expect(iframeNode?.name).toBeUndefined();
  });

  it("parses the balance panel: row-header cells map to the correct formatted values", () => {
    const frame = parseFrameSnapshot(readFixture("balance-panel.aria.yaml"), {
      frameId: "iframe:Account Balance",
      url: "/members/10001/balance",
    });
    const rowheaders = findAll(frame.nodes, "rowheader").map((n) => n.name);
    expect(rowheaders).toEqual(["Savings", "Checking"]);
  });
});

describe("parseFrameSnapshot — synthetic edge cases", () => {
  it("parses a bare role with no name", () => {
    const frame = parseFrameSnapshot("- iframe\n", { frameId: "main", url: "/x" });
    expect(frame.nodes[0]?.role).toBe("iframe");
    expect(frame.nodes[0]?.name).toBeUndefined();
  });

  it("parses a role with attributes and no name", () => {
    const frame = parseFrameSnapshot("- checkbox [checked]\n", { frameId: "main", url: "/x" });
    expect(frame.nodes[0]?.role).toBe("checkbox");
    expect(frame.nodes[0]?.attrs).toEqual({ checked: "" });
  });

  it("parses a role with a name and multiple attributes", () => {
    const frame = parseFrameSnapshot('- heading "Title" [level=2]\n', { frameId: "main", url: "/x" });
    expect(frame.nodes[0]).toMatchObject({ role: "heading", name: "Title", attrs: { level: "2" } });
  });

  it("captures a nested text: child as the node's text field", () => {
    const yaml = '- generic:\n  - text: Sample accessible name\n';
    const frame = parseFrameSnapshot(yaml, { frameId: "main", url: "/x" });
    expect(frame.nodes[0]?.children[0]?.text).toBe("Sample accessible name");
  });

  it("assigns sequential ordinals to repeated role+name siblings, and 0 to unique ones", () => {
    const yaml = [
      "- button \"OK\"",
      "- button \"Cancel\"",
      "- group:",
      "  - button \"OK\"",
    ].join("\n");
    const frame = parseFrameSnapshot(yaml, { frameId: "main", url: "/x" });
    const okButtons = findAll(frame.nodes, "button").filter((n) => n.name === "OK");
    expect(okButtons).toHaveLength(2);

    // ordinals live on the actual nodes, not the flattened summary — re-walk to check them.
    const ordinals: number[] = [];
    const walk = (list: typeof frame.nodes) => {
      for (const node of list) {
        if (node.role === "button" && node.name === "OK") {
          ordinals.push(node.ordinal);
        }
        walk(node.children);
      }
    };
    walk(frame.nodes);
    expect(ordinals).toEqual([0, 1]);

    const cancelOrdinal = findAll(frame.nodes, "button").find((n) => n.name === "Cancel");
    expect(cancelOrdinal).toBeDefined();
  });

  it("assigns stable refs deterministically across repeated parses of the same text", () => {
    const yaml = '- button "OK"\n- button "Cancel"\n';
    const first = parseFrameSnapshot(yaml, { frameId: "main", url: "/x" });
    const second = parseFrameSnapshot(yaml, { frameId: "main", url: "/x" });
    expect(first.nodes.map((n) => n.ref)).toEqual(second.nodes.map((n) => n.ref));
  });
});

describe("resolveRef", () => {
  function snapshotFor(yaml: string): Snapshot {
    return { frames: [parseFrameSnapshot(yaml, { frameId: "main", url: "/x" })] };
  }

  it("resolves a unique role+name node without an nth", () => {
    const snapshot = snapshotFor('- button "Search"\n');
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const chain = resolveRef(snapshot, "main", ref);
    expect(chain).toEqual([
      expect.objectContaining({ kind: "role", role: "button", name: "Search", exact: true }),
    ]);
    expect(chain[0]).not.toHaveProperty("nth");
  });

  it("resolves the second of two same role+name nodes with nth: 1", () => {
    const snapshot = snapshotFor('- button "OK"\n- button "OK"\n');
    const secondRef = snapshot.frames[0]!.nodes[1]!.ref;
    const chain = resolveRef(snapshot, "main", secondRef);
    expect(chain[0]).toMatchObject({ kind: "role", role: "button", name: "OK", nth: 1 });
  });

  it("throws a clear error for an unknown ref", () => {
    const snapshot = snapshotFor('- button "Search"\n');
    expect(() => resolveRef(snapshot, "main", "not-a-real-ref")).toThrow(/No node with ref/);
  });

  it("throws a clear error for a node with no accessible name", () => {
    const snapshot = snapshotFor("- iframe\n");
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    expect(() => resolveRef(snapshot, "main", ref)).toThrow(/no accessible name/);
  });
});
