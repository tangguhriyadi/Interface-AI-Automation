import { escapeHtml, labeledRow, logoutForm, renderPage } from "./layout.js";

export interface SubAccountReviewPageOptions {
  memberId: string;
  accountTypeValue: string;
  accountTypeLabel: string;
  initialDepositRaw: string;
  initialDepositFormatted: string;
  termsAccepted: boolean;
  token: string;
}

/**
 * Stateless except for the one-time confirm token: nothing about the
 * submitted values is persisted, but the token (session-issued, see
 * session.ts) is required to actually create the sub-account, so a double
 * submit of this page's Confirm form can't create it twice.
 */
export function renderSubAccountReviewPage({
  memberId,
  accountTypeValue,
  accountTypeLabel,
  initialDepositRaw,
  initialDepositFormatted,
  termsAccepted,
  token,
}: SubAccountReviewPageOptions): string {
  const memberIdPath = encodeURIComponent(memberId);
  const backHiddenFields = `<input type="hidden" name="accountType" value="${escapeHtml(accountTypeValue)}">
          <input type="hidden" name="initialDeposit" value="${escapeHtml(initialDepositRaw)}">
          ${termsAccepted ? `<input type="hidden" name="termsAccepted" value="on">` : ""}`;
  const confirmHiddenFields = `${backHiddenFields}
          <input type="hidden" name="token" value="${escapeHtml(token)}">`;

  const bodyHtml = `        <table>
          <tbody>
${labeledRow("Account Type", accountTypeLabel)}
${labeledRow("Initial Deposit", initialDepositFormatted)}
${labeledRow("Terms Accepted", termsAccepted ? "Yes" : "No")}
          </tbody>
        </table>
        <form method="get" action="/members/${memberIdPath}/sub-account/new">
          ${backHiddenFields}
          <button type="submit">Back</button>
        </form>
        <form method="post" action="/members/${memberIdPath}/sub-account/confirm">
          ${confirmHiddenFields}
          <button type="submit">Confirm and Open Account</button>
        </form>
        ${logoutForm()}
`;
  return renderPage({ title: "Review Sub-Account", bodyHtml });
}
