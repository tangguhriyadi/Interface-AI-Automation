import { escapeHtml, logoutForm, renderPage } from "./layout.js";
import type { TenantLabels } from "../tenantLabels.js";

export interface SearchPageOptions {
  labels: TenantLabels;
  error?: string;
}

export function renderSearchPage({ labels, error }: SearchPageOptions): string {
  const notice = error ? `        <p role="alert">${escapeHtml(error)}</p>\n` : "";
  const bodyHtml = `${notice}        <form method="post" action="/search">
          <table>
            <tbody>
              <tr>
                <td><label for="memberId">${escapeHtml(labels.memberIdLabel)}</label></td>
                <td><input id="memberId" name="memberId" type="text"></td>
              </tr>
            </tbody>
          </table>
          <button type="submit">${escapeHtml(labels.searchButtonLabel)}</button>
        </form>
        ${logoutForm()}
`;
  return renderPage({ title: "Member Search", bodyHtml });
}
