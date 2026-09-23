import { describe, expect, it } from "vitest";
import { parseFrameSnapshot, type Snapshot } from "../../adapter/snapshotParser.js";
import { deriveCheckpoint } from "../../discovery/deriveCheckpoint.js";

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

describe("deriveCheckpoint — heading with a colon separator", () => {
  it("derives heading_starts_with using the stable prefix up to and including the colon, not the full observed text", () => {
    // Single-quote-wrapped: an unquoted plain scalar containing ": " breaks YAML parsing.
    const snapshot = snapshotFor("- 'heading \"Member: Elena Cho\" [level=1]'\n");
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, []);
    expect(result).toEqual({ ok: true, checkpoint: { kind: "heading_starts_with", text: "Member:" } });
  });
});

describe("deriveCheckpoint — heading with no colon separator", () => {
  it("derives heading_starts_with using the full heading text when there's no variable suffix to strip", () => {
    const snapshot = snapshotFor('- heading "Account Balance" [level=1]\n');
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, []);
    expect(result).toEqual({ ok: true, checkpoint: { kind: "heading_starts_with", text: "Account Balance" } });
  });
});

describe("deriveCheckpoint — non-heading text-bearing node", () => {
  it("derives text_contains for an alert or paragraph, not heading_starts_with", () => {
    const snapshot = snapshotFor("- alert: Your request was submitted successfully\n");
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, []);
    expect(result).toEqual({
      ok: true,
      checkpoint: { kind: "text_contains", text: "Your request was submitted successfully" },
    });
  });

  it("scopes the checkpoint's frame field when the ref is in a sub-frame", () => {
    const snapshot = snapshotFor('- heading "Account Balance" [level=1]\n', {
      frameId: "iframe:Account Balance",
      title: "Account Balance",
    });
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "iframe:Account Balance", ref }, []);
    expect(result).toEqual({
      ok: true,
      checkpoint: {
        kind: "heading_starts_with",
        text: "Account Balance",
        frame: { by: "title", value: "Account Balance" },
      },
    });
  });
});

describe("deriveCheckpoint — frame-only proof (ref omitted)", () => {
  it("derives frame_present for a named sub-frame", () => {
    const snapshot = snapshotFor("- heading \"x\"\n", { frameId: "iframe:Account Balance", title: "Account Balance" });
    const result = deriveCheckpoint(snapshot, { frameId: "iframe:Account Balance" }, []);
    expect(result).toEqual({
      ok: true,
      checkpoint: { kind: "frame_present", frame: { by: "title", value: "Account Balance" } },
    });
  });

  it("refuses a frame-only proof naming the main frame — always present, not a distinguishing signal", () => {
    const snapshot = snapshotFor('- heading "x"\n');
    const result = deriveCheckpoint(snapshot, { frameId: "main" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/main frame is always present/i);
    }
  });
});

describe("deriveCheckpoint — the PII/secret safety net", () => {
  it("refuses a derivation whose text would contain a value already known to be sensitive this run (e.g. a read output)", () => {
    // Elena Cho's name was already read into the memberName output this run — using a heading
    // that repeats it as the success proof would bake that PII into the artifact's checkpoint.
    const snapshot = snapshotFor('- heading "Confirmed for Elena Cho" [level=1]\n');
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, ["Elena Cho"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/secret|pii|sensitive/i);
    }
  });

  it("still succeeds when the sensitive value is known but doesn't appear in the derived text", () => {
    const snapshot = snapshotFor('- heading "Confirmed" [level=1]\n');
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, ["Elena Cho"]);
    expect(result).toEqual({ ok: true, checkpoint: { kind: "heading_starts_with", text: "Confirmed" } });
  });
});

describe("deriveCheckpoint — invalid proof", () => {
  it("refuses a proof naming an unknown frame", () => {
    const snapshot = snapshotFor('- heading "x"\n');
    const result = deriveCheckpoint(snapshot, { frameId: "iframe:Nonexistent" }, []);
    expect(result.ok).toBe(false);
  });

  it("refuses a proof naming an unknown ref", () => {
    const snapshot = snapshotFor('- heading "x"\n');
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref: "not-a-real-ref" }, []);
    expect(result.ok).toBe(false);
  });

  it("refuses a proof pointing at a node with no name or text to prove success with", () => {
    const snapshot = snapshotFor("- iframe\n");
    const ref = snapshot.frames[0]!.nodes[0]!.ref;
    const result = deriveCheckpoint(snapshot, { frameId: "main", ref }, []);
    expect(result.ok).toBe(false);
  });
});
