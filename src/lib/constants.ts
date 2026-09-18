/**
 * Centralized Application Constants
 */

// Route Paths
export const ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  SIGNUP: '/signup',
  DASHBOARD: '/dashboard',
  AGENDA: '/dashboard/calendar',
  PATIENTS: '/dashboard/patients',
  REPORTS: '/dashboard/reports',
  SETTINGS: '/dashboard/settings',
} as const;

// App Configuration & Service Worker
export const SW_SCOPE = '/';
export const SW_SCRIPT_URL = '/sw.js';
