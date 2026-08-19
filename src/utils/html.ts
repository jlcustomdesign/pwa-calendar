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
 * Escape a string so it can be safely used inside a single-quoted JS string
 * inside an inline HTML event handler (onclick='...').
 */
export function escapeJsString(input: string | undefined | null): string {
  if (input === undefined || input === null) return '';
  return String(input)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
