import { escapeHtml, logoutForm, renderPage } from "./layout.js";
import { SUB_ACCOUNT_TYPES } from "../subAccountTypes.js";

export interface SubAccountNewPageOptions {
  memberId: string;
  accountType?: string;
  initialDeposit?: string;
  termsAccepted?: boolean;
  error?: string;
}

export function renderSubAccountNewPage({
  memberId,
  accountType = "",
  initialDeposit = "",
  termsAccepted = false,
  error,
}: SubAccountNewPageOptions): string {
  const notice = error ? `        <p role="alert">${escapeHtml(error)}</p>\n` : "";
  const options = SUB_ACCOUNT_TYPES.map(
    (type) =>
      `<option value="${escapeHtml(type.value)}"${type.value === accountType ? " selected" : ""}>${escapeHtml(type.label)}</option>`,
  ).join("");

  const bodyHtml = `${notice}        <form method="post" action="/members/${encodeURIComponent(memberId)}/sub-account/review">
          <table>
            <tbody>
              <tr>
                <td><label for="accountType">Account Type</label></td>
                <td>
                  <select id="accountType" name="accountType">
                    <option value=""${accountType === "" ? " selected" : ""}>Select an account type</option>
                    ${options}
                  </select>
                </td>
              </tr>
              <tr>
                <td><label for="initialDeposit">Initial Deposit</label></td>
                <td><input id="initialDeposit" name="initialDeposit" type="text" value="${escapeHtml(initialDeposit)}"></td>
              </tr>
              <tr>
                <td><label for="termsAccepted">I agree to the terms and conditions</label></td>
                <td><input id="termsAccepted" name="termsAccepted" type="checkbox"${termsAccepted ? " checked" : ""}></td>
              </tr>
            </tbody>
          </table>
          <button type="submit">Continue</button>
        </form>
        ${logoutForm()}
`;
  return renderPage({ title: "Open Sub-Account", bodyHtml });
}
