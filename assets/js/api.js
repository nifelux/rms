/**
 * API Wrapper
 * Handles fetch requests with JWT token, error handling, and retries.
 */
import { getCurrentUser } from './auth.js';

const API_BASE = window.APP_CONFIG.API_BASE;

async function request(endpoint, options = {}) {
  const user = await getCurrentUser();
  let token = '';
  if (user) {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token || '';
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers
  };

  const res = await fetch(`${API_BASE}/${endpoint}`, {
    ...options,
    headers
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}

export function get(endpoint) {
  return request(endpoint, { method: 'GET' });
}

export function post(endpoint, body) {
  return request(endpoint, { method: 'POST', body: JSON.stringify(body) });
}

export function put(endpoint, body) {
  return request(endpoint, { method: 'PUT', body: JSON.stringify(body) });
}

export function del(endpoint) {
  return request(endpoint, { method: 'DELETE' });
}

// Helper to construct query parameters
export function buildQuery(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return qs ? `?${qs}` : '';
}
