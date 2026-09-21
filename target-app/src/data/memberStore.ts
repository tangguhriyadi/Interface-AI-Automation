import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MemberAccounts {
  savings: number;
  checking: number;
}

export interface SubAccount {
  id: string;
  accountType: string;
  initialDepositCents: number;
  openedAt: string;
}

export interface Member {
  memberId: string;
  name: string;
  status: "active";
  accounts: MemberAccounts;
  subAccounts: SubAccount[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, "..", "fixtures", "members.json");

function loadFixtures(): Map<string, Member> {
  const raw = JSON.parse(readFileSync(fixturesPath, "utf-8")) as Record<string, Member>;
  return new Map(Object.entries(raw).map(([memberId, member]) => [memberId, structuredClone(member)]));
}

const members = loadFixtures();

let subAccountCounter = 0;

export function getMember(memberId: string): Member | undefined {
  return members.get(memberId);
}

export function addSubAccount(
  memberId: string,
  accountType: string,
  initialDepositCents: number,
): SubAccount {
  const member = members.get(memberId);
  if (!member) {
    throw new Error(`Cannot open sub-account: member ${memberId} not found`);
  }
  subAccountCounter += 1;
  const subAccount: SubAccount = {
    id: `SA-${String(subAccountCounter).padStart(4, "0")}`,
    accountType,
    initialDepositCents,
    openedAt: new Date().toISOString(),
  };
  member.subAccounts.push(subAccount);
  return subAccount;
}
