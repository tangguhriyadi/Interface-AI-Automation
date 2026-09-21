export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PageOptions {
  title: string;
  bodyHtml: string;
}

/**
 * Every page is a nested-table shell: an outer "page frame" table holding a
 * heading row and a content row, whose cell each page fills with its own
 * inner table(s). This mirrors the legacy nested-table layout the real
 * console uses, while every control inside stays native HTML so the
 * accessibility tree yields real roles and names.
 */
export function renderPage({ title, bodyHtml }: PageOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
<table>
  <tbody>
    <tr>
      <td>
        <h1>${escapeHtml(title)}</h1>
      </td>
    </tr>
    <tr>
      <td>
${bodyHtml}
      </td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;
}

/** A label/value row using a row header, so the value is reachable by header-to-cell association. */
export function labeledRow(label: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}
