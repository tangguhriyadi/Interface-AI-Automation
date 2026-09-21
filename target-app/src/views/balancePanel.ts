import { labeledRow, renderPage } from "./layout.js";
import { formatMoney } from "../money.js";
import type { MemberAccounts } from "../data/memberStore.js";

export interface BalancePanelOptions {
  accounts: MemberAccounts;
}

/**
 * Standalone document loaded as the member detail page's iframe content.
 * Values are reachable via row-header (`th scope="row"`) to cell
 * association, not column position.
 */
export function renderBalancePanel({ accounts }: BalancePanelOptions): string {
  const bodyHtml = `        <table>
          <tbody>
${labeledRow("Savings", formatMoney(accounts.savings))}
${labeledRow("Checking", formatMoney(accounts.checking))}
          </tbody>
        </table>
`;
  return renderPage({ title: "Account Balance", bodyHtml });
}
