/**
 * Mask a phone number for safe logging.
 * "9876543210" → "****3210"
 * "+919876543210" → "+91****3210"
 */
export function maskPhone(phone: string | number | null | undefined): string {
  if (!phone) return '***';
  const str = String(phone).trim();
  if (str.length <= 4) return '****';

  // Preserve country code prefix if present
  const match = str.match(/^(\+\d{1,3})?(.+)$/);
  if (!match) return '****';

  const prefix = match[1] || '';
  const number = match[2];

  if (number.length <= 4) return `${prefix}****`;
  const visible = number.slice(-4);
  return `${prefix}${'*'.repeat(number.length - 4)}${visible}`;
}
