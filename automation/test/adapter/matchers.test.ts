import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrameSnapshot } from "../../adapter/snapshotParser.js";
import {
  alertText,
  findFrame,
  frameExists,
  headingText,
  matchesAnyShape,
  matchesShape,
  visibleTextContains,
} from "../../adapter/matchers.js";
import type { Snapshot } from "../../adapter/snapshotParser.js";
import { loadAppProfile } from "../../schema/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appProfilePath = join(__dirname, "..", "..", "..", "capabilities", "fake-credit-union-console.app-profile.json");

const memberNotFoundYaml = [
  '- heading "Member Not Found" [level=1]',
  '- text: No member matches ID 99999.',
].join("\n");

const inlineInvalidInputYaml = [
  '- heading "Member Search" [level=1]',
  '- text: "Invalid Input: Member ID is required."',
].join("\n");

function snapshotWith(mainYaml: string, extraFrames: { frameId: string; title?: string; url: string; yaml: string }[] = []): Snapshot {
  const frames = [parseFrameSnapshot(mainYaml, { frameId: "main", url: "/x" })];
  for (const extra of extraFrames) {
    frames.push(
      parseFrameSnapshot(extra.yaml, {
        frameId: extra.frameId,
        url: extra.url,
        ...(extra.title !== undefined ? { title: extra.title } : {}),
      }),
    );
  }
  return { frames };
}

describe("headingText", () => {
  it("returns the first heading's accessible name in the main frame", () => {
    const snapshot = snapshotWith(memberNotFoundYaml);
    expect(headingText(snapshot)).toBe("Member Not Found");
  });

  it("returns undefined when there is no heading", () => {
    const snapshot = snapshotWith('- text: nothing here');
    expect(headingText(snapshot)).toBeUndefined();
  });
});

describe("alertText — never assumes role=alert exists", () => {
  it("returns undefined, not empty string, when there is no alert node", () => {
    const snapshot = snapshotWith(memberNotFoundYaml);
    expect(alertText(snapshot)).toBeUndefined();
  });

  it("returns the alert node's text when present", () => {
    const snapshot = snapshotWith('- alert: Invalid username or password.');
    // "alert:" with a plain string value parses as a node whose shorthand key is "alert"
    // (bare role, no name) and whose text child carries the message.
    expect(alertText(snapshot)).toBe("Invalid username or password.");
  });
});

describe("visibleTextContains — covers both shapes of the same outcome", () => {
  it("matches the full-page shape", () => {
    const snapshot = snapshotWith(memberNotFoundYaml);
    expect(visibleTextContains(snapshot, "No member matches ID 99999.")).toBe(true);
  });

  it("matches the inline-alert-on-search-page shape (CLAUDE.md's own example)", () => {
    const snapshot = snapshotWith(inlineInvalidInputYaml);
    expect(visibleTextContains(snapshot, "Invalid Input")).toBe(true);
    expect(headingText(snapshot)).toBe("Member Search");
  });

  it("returns false for text that isn't present", () => {
    const snapshot = snapshotWith(memberNotFoundYaml);
    expect(visibleTextContains(snapshot, "Access Denied")).toBe(false);
  });
});

describe("findFrame / frameExists", () => {
  const snapshot = snapshotWith(memberNotFoundYaml, [
    { frameId: "iframe:Account Balance", title: "Account Balance", url: "/members/10001/balance", yaml: '- heading "Account Balance" [level=1]' },
  ]);

  it("finds the main frame when no ref is given", () => {
    expect(findFrame(snapshot)?.frameId).toBe("main");
  });

  it("finds a sub-frame by title", () => {
    const frame = findFrame(snapshot, { by: "title", value: "Account Balance" });
    expect(frame?.frameId).toBe("iframe:Account Balance");
  });

  it("frameExists is true for a present frame and false for an absent one", () => {
    expect(frameExists(snapshot, { by: "title", value: "Account Balance" })).toBe(true);
    expect(frameExists(snapshot, { by: "title", value: "Nonexistent" })).toBe(false);
  });
});

describe("matchesShape / matchesAnyShape — against the real, hand-authored target-app app profile", () => {
  const appProfile = loadAppProfile(appProfilePath);

  const normalMemberDetailSnapshot = snapshotWith(
    ['- \'heading "Member: Elena Cho" [level=1]\'', '- rowheader "Name"', '- cell "Elena Cho"'].join("\n"),
  );

  it("member_not_found: matches a page with the alert role and no name-based signal required", () => {
    const snapshot = snapshotWith(
      ['- heading "Member Not Found" [level=1]', "- alert: No member matches ID 99999."].join("\n"),
    );
    const outcome = appProfile.outcomes["member_not_found"]!;
    expect(matchesAnyShape(outcome.shapes, snapshot)).toBe(true);
    expect(matchesAnyShape(outcome.shapes, normalMemberDetailSnapshot)).toBe(false);
  });

  it("member_not_found: still matches when there is no role=alert at all (never assume it exists)", () => {
    const snapshot = snapshotWith(
      ['- heading "Member Not Found" [level=1]', "- text: No member matches ID 12345."].join("\n"),
    );
    const outcome = appProfile.outcomes["member_not_found"]!;
    expect(matchesAnyShape(outcome.shapes, snapshot)).toBe(true);
  });

  it("access_denied: matches the real rendered message", () => {
    const snapshot = snapshotWith(
      ['- heading "Access Denied" [level=1]', "- alert: Access to member 10002 is restricted."].join("\n"),
    );
    const outcome = appProfile.outcomes["access_denied"]!;
    expect(matchesAnyShape(outcome.shapes, snapshot)).toBe(true);
    expect(matchesAnyShape(outcome.shapes, normalMemberDetailSnapshot)).toBe(false);
  });

  it("invalid_input: matches both the full-page shape and the inline-alert-on-search-page shape", () => {
    const outcome = appProfile.outcomes["invalid_input"]!;

    const fullPage = snapshotWith(
      ['- heading "Invalid Input" [level=1]', "- alert: Member ID must contain only digits."].join("\n"),
    );
    const inlineOnSearch = snapshotWith(
      ['- heading "Member Search" [level=1]', '- alert: "Invalid Input: Member ID is required."'].join("\n"),
    );

    expect(matchesAnyShape(outcome.shapes, fullPage)).toBe(true);
    expect(matchesAnyShape(outcome.shapes, inlineOnSearch)).toBe(true);
    expect(matchesAnyShape(outcome.shapes, normalMemberDetailSnapshot)).toBe(false);
  });

  it("maintenance_interstitial recovery: matches the real interstitial page", () => {
    const snapshot = snapshotWith(
      [
        '- heading "System Maintenance" [level=1]',
        "- text: The servicing console is undergoing scheduled maintenance.",
      ].join("\n"),
    );
    const recovery = appProfile.recoveries.find((r) => r.name === "maintenance_interstitial")!;
    expect(matchesAnyShape(recovery.detect, snapshot)).toBe(true);
    expect(matchesAnyShape(recovery.detect, normalMemberDetailSnapshot)).toBe(false);
  });

  it("individual matchesShape call requires every declared signal (AND, not OR)", () => {
    const headingOnlyMatch = snapshotWith('- heading "Access Denied" [level=1]');
    const shape = appProfile.outcomes["access_denied"]!.shapes[0]!;
    // heading matches but the required textContains ("restricted") is absent
    expect(matchesShape(shape, headingOnlyMatch)).toBe(false);
  });
});
