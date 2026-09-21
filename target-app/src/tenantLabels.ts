export interface TenantLabels {
  memberIdLabel: string;
  searchButtonLabel: string;
}

export function getTenantLabels(tenant: string): TenantLabels {
  if (tenant === "beta") {
    return { memberIdLabel: "Account Number", searchButtonLabel: "Find" };
  }
  return { memberIdLabel: "Member ID", searchButtonLabel: "Search" };
}
