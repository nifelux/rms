/**
 * Application Configuration
 * Frontend constants, API base URL, feature flags.
 */
window.APP_CONFIG = {
  API_BASE: '/api',
  SUPABASE_URL: 'https://ofysznsajwxnjqaumwch.supabase.co', // Replace with env or real URL
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9meXN6bnNhand4bmpxYXVtd2NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMzM4NDgsImV4cCI6MjEwMzgwOTg0OH0.XaHkP5WZ2nJVJXVdbG-D13rrD63g_09HxmJoZn7ZoWA',
  CURRENCY: 'NGN',
  LOCALE: 'en-NG',
  TELEGRAM_ENABLED: true,
  MAINTENANCE_MODE: false // Overridden by backend check
};
