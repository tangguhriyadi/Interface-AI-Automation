export interface SubAccountTypeOption {
  value: string;
  label: string;
}

export const SUB_ACCOUNT_TYPES: SubAccountTypeOption[] = [
  { value: "savings-club", label: "Savings Club" },
  { value: "money-market", label: "Money Market" },
  { value: "certificate-of-deposit", label: "Certificate of Deposit" },
];

export function isValidSubAccountType(value: string): boolean {
  return SUB_ACCOUNT_TYPES.some((type) => type.value === value);
}

export function subAccountTypeLabel(value: string): string {
  return SUB_ACCOUNT_TYPES.find((type) => type.value === value)?.label ?? value;
}
