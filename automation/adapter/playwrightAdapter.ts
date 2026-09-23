import { chromium, type Browser, type FrameLocator, type Locator, type Page } from "playwright";
import type { FrameRef } from "../schema/frame.js";
import type { LocatorChain, LocatorStrategy } from "../schema/locator.js";
import { parseFrameSnapshot, type Snapshot } from "./snapshotParser.js";
import type { ActionResult, ReadResult, SurfaceAdapter } from "./surfaceAdapter.js";

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Translates a semantic FrameRef into whatever the surface actually needs
 * to find it — here, a Playwright frameLocator built from a CSS attribute
 * selector. This is deliberately the *only* place a CSS selector for frame
 * targeting exists; the artifact never sees it (schema/frame.ts stays
 * driver-agnostic).
 *
 * Why an attribute selector rather than role+name: verified empirically
 * against a live target-app page (evidence/accessibility-snapshot-spike/),
 * not assumed. `page.getByRole('iframe', { name: 'Account Balance' })`
 * finds zero matches even though the iframe has `title="Account Balance"`
 * — the title attribute does not surface as the iframe's accessible name
 * in Chromium's computed a11y tree. `getByTitle()` / a `[title=...]`
 * selector does find it. This fallback is evidence-based, not a shortcut.
 */
function resolveFrameScope(page: Page, frame: FrameRef | undefined): Page | FrameLocator {
  if (!frame) {
    return page;
  }
  const value = escapeAttributeValue(frame.value);
  switch (frame.by) {
    case "title":
      return page.frameLocator(`iframe[title="${value}"]`);
    case "name":
      return page.frameLocator(`iframe[name="${value}"]`);
    case "url":
      return page.frameLocator(`iframe[src*="${value}"]`);
  }
}

function buildLocatorForStrategy(scope: Page | FrameLocator, strategy: LocatorStrategy): Locator {
  switch (strategy.kind) {
    case "role": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- role is a validated ARIA role string at authoring time, not enumerable here without importing Playwright's role union into the schema layer.
      let locator = scope.getByRole(strategy.role as any, { name: strategy.name, exact: strategy.exact });
      if (strategy.nth !== undefined) {
        locator = locator.nth(strategy.nth);
      }
      return locator;
    }
    case "label":
      return scope.getByLabel(strategy.text, { exact: strategy.exact });
    case "structural":
      // The row-header cell (role="rowheader") identifies the row; the sibling
      // data cell (role="cell") is what a read/type/click step actually targets.
      return scope
        .getByRole("rowheader", { name: strategy.rowHeader, exact: true })
        .locator("xpath=..")
        .getByRole("cell");
    case "css":
      return scope.locator(strategy.selector);
    case "xpath":
      return scope.locator(`xpath=${strategy.expression}`);
  }
}

async function resolveLocator(
  scope: Page | FrameLocator,
  chain: LocatorChain,
): Promise<{ locator: Locator; strategy: LocatorStrategy }> {
  const attempts: string[] = [];
  for (const strategy of chain) {
    const locator = buildLocatorForStrategy(scope, strategy);
    const count = await locator.count();
    if (count === 1) {
      return { locator, strategy };
    }
    attempts.push(`${strategy.kind} (${strategy.rationale}): ${count} matches`);
  }
  throw new Error(`No locator strategy in the chain resolved to exactly one element. Tried:\n${attempts.join("\n")}`);
}

export class PlaywrightAdapter implements SurfaceAdapter {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  static async launch(baseUrl: string): Promise<PlaywrightAdapter> {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    return new PlaywrightAdapter(browser, page, baseUrl);
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(`${this.baseUrl}${path}`);
  }

  async click(target: LocatorChain, frame?: FrameRef): Promise<ActionResult> {
    const { locator, strategy } = await resolveLocator(resolveFrameScope(this.page, frame), target);
    await locator.click();
    return { matchedStrategy: strategy };
  }

  async type(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult> {
    const { locator, strategy } = await resolveLocator(resolveFrameScope(this.page, frame), target);
    await locator.fill(value);
    return { matchedStrategy: strategy };
  }

  async select(target: LocatorChain, value: string, frame?: FrameRef): Promise<ActionResult> {
    const { locator, strategy } = await resolveLocator(resolveFrameScope(this.page, frame), target);
    await locator.selectOption(value);
    return { matchedStrategy: strategy };
  }

  async read(target: LocatorChain, frame?: FrameRef): Promise<ReadResult> {
    const { locator, strategy } = await resolveLocator(resolveFrameScope(this.page, frame), target);
    const value = (await locator.textContent()) ?? "";
    return { matchedStrategy: strategy, value: value.trim() };
  }

  async snapshot(): Promise<Snapshot> {
    // Frame URLs can read as empty immediately after a triggering action; waiting for
    // load state first is what the live spike found necessary (evidence/accessibility-snapshot-spike/).
    await this.page.waitForLoadState("networkidle").catch(() => undefined);

    const mainRaw = await this.page.locator("body").ariaSnapshot();
    const frames = [parseFrameSnapshot(mainRaw, { frameId: "main", url: this.page.url() })];

    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) {
        continue;
      }
      const element = await frame.frameElement();
      const title = (await element.getAttribute("title")) ?? undefined;
      const name = (await element.getAttribute("name")) ?? undefined;
      const frameId = title ? `iframe:${title}` : name ? `iframe:${name}` : `iframe:${frame.url()}`;
      const raw = await frame.locator("body").ariaSnapshot();
      frames.push(
        parseFrameSnapshot(raw, {
          frameId,
          url: frame.url(),
          ...(title !== undefined ? { title } : {}),
          ...(name !== undefined ? { name } : {}),
        }),
      );
    }

    return { frames };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
