import { labeledRow, logoutForm, renderPage } from "./layout.js";
import type { Member } from "../data/memberStore.js";

export interface MemberDetailPageOptions {
  member: Member;
}

export function renderMemberDetailPage({ member }: MemberDetailPageOptions): string {
  const memberIdPath = encodeURIComponent(member.memberId);
  const bodyHtml = `        <table>
          <tbody>
${labeledRow("Name", member.name)}
${labeledRow("Member ID", member.memberId)}
${labeledRow("Status", member.status)}
          </tbody>
        </table>
        <iframe title="Account Balance" src="/members/${memberIdPath}/balance"></iframe>
        <form method="get" action="/members/${memberIdPath}/sub-account/new">
          <button type="submit">Open Sub-Account</button>
        </form>
        ${logoutForm()}
`;
  return renderPage({ title: `Member: ${member.name}`, bodyHtml });
}
