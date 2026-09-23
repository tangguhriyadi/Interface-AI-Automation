import { escapeHtml, renderPage } from "./layout.js";

export interface MessagePageOptions {
  title: string;
  message: string;
}

/**
 * A single-message page used for both business outcomes (e.g. "Member Not
 * Found", "Access Denied") and hard failures (e.g. "Server Error"). Callers
 * must pass a distinct title for each case — /automation tells these apart by what
 * the page says, not by HTTP status code, so the heading is the signal.
 */
export function renderMessagePage({ title, message }: MessagePageOptions): string {
  return renderPage({
    title,
    bodyHtml: `        <p role="alert">${escapeHtml(message)}</p>\n`,
  });
}
