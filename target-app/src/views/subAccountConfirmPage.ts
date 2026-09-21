import { escapeHtml, labeledRow, logoutForm, renderPage } from "./layout.js";

export interface SubAccountConfirmPageOptions {
  memberId: string;
  subAccountId: string;
  accountTypeLabel: string;
  initialDepositFormatted: string;
}

/**
 * The success checkpoint for the whole flow: a stable heading
 * ("Sub-Account Created", from renderPage's title) plus an explicit
 * "Sub-Account ID: ..." line a replay executor can assert on.
 */
export function renderSubAccountConfirmPage({
  memberId,
  subAccountId,
  accountTypeLabel,
  initialDepositFormatted,
}: SubAccountConfirmPageOptions): string {
  const bodyHtml = `        <p>Sub-Account ID: ${escapeHtml(subAccountId)}</p>
        <table>
          <tbody>
${labeledRow("Account Type", accountTypeLabel)}
${labeledRow("Initial Deposit", initialDepositFormatted)}
          </tbody>
        </table>
        <form method="get" action="/members/${encodeURIComponent(memberId)}">
          <button type="submit">Back to Member</button>
        </form>
        ${logoutForm()}
`;
  return renderPage({ title: "Sub-Account Created", bodyHtml });
}
