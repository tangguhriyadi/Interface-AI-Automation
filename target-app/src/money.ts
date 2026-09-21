/** Formats an integer amount of cents as fixed US currency, e.g. 123456 -> "$1,234.56". */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
