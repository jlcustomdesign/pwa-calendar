// Nume de evenimente globale — sursă unică de adevăr pentru CustomEvent bus.
// Înainte acestea erau stringuri magice duplicate în ~10 fișiere; o greșeală
// de typo eșua silențios la runtime.

export const EVENTS = {
  // evenimente de deschidere sheets
  openAddSession: 'openAddSession',
  openPaymentSheet: 'openPaymentSheet',
  openRenewalSheet: 'openRenewalSheet',
  openWrapUp: 'openWrapUp',
  openAddPatient: 'openAddPatient',
  openShareScheduleSheet: 'openShareScheduleSheet',
  // evenimente de reîmprospătare date
  sessionsUpdated: 'sessionsUpdated',
  patientsUpdated: 'patientsUpdated',
  paymentsUpdated: 'paymentsUpdated',
  settingsUpdated: 'settingsUpdated',
  // flux wrap-up
  sessionWrapupClosed: 'sessionWrapupClosed',
  showFrequencyPrompt: 'showFrequencyPrompt',
  profileUpdated: 'profileUpdated',
  // calendar
  calendarDateSelected: 'calendarDateSelected',
} as const;

export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

export function emit(name: AppEventName, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
}
