/**
 * html.ts — utilities for safely rendering user-controlled text in HTML.
 */

/**
 * Escape special HTML characters so user-controlled strings can be safely
 * inserted into HTML text or attribute contexts.
 */
export function escapeHtml(input: string | number | undefined | null): string {
  if (input === undefined || input === null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate that a URL uses an allowed scheme for user-controlled links.
 * Allowed schemes: http:, https:, tel:.
 */
export function isAllowedUrl(url: string | undefined | null): boolean {
  if (!url || url === '#' || url === 'javascript:void(0)') return false;
  const trimmed = String(url).trim();
  if (/^tel:/i.test(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
