import { escapeHtml, renderPage } from "./layout.js";

export interface InterstitialPageOptions {
  dismissAction: string;
}

/**
 * Server-rendered, dismissable maintenance notice. The caller wires
 * `dismissAction` to a route that marks the interstitial dismissed for the
 * current session and redirects back — no client-side JS involved.
 */
export function renderInterstitialPage({ dismissAction }: InterstitialPageOptions): string {
  const bodyHtml = `        <p>The servicing console is undergoing scheduled maintenance. Some information may be temporarily unavailable.</p>
        <form method="post" action="${escapeHtml(dismissAction)}">
          <button type="submit">Dismiss</button>
        </form>
`;
  return renderPage({ title: "System Maintenance", bodyHtml });
}
