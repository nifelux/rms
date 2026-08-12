/**
 * Authentication API
 * Actions: register, login, logout, refresh, updateProfile, checkAdmin
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { rateLimit } from '../lib/rate-limit.js';

export default async function handler(req, res) {
  const { action } = req.query;

  try {
    switch (action) {
      case 'register': return register(req, res);
      case 'login': return login(req, res);
      case 'logout': return logout(req, res);
      case 'profile': return getProfile(req, res);
      case 'updateProfile': return updateProfile(req, res);
      case 'isAdmin': return checkAdmin(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error(`Auth API error (${action}):`, err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}

async function register(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (!rateLimit(`register_${ip}`, 3, 60000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  const { email, password, fullName, referralCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Check if referral code exists
  let referredBy = null;
  if (referralCode) {
    const { data: refProfile } = await supabaseAdmin.from('profiles').select('id').eq('referral_code', referralCode).single();
    if (refProfile) referredBy = refProfile.id;
  }

  const { data, error } = await supabaseAdmin.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName || '' } }
  });
  if (error) return res.status(400).json({ error: error.message });

  const user = data.user;
  // Update profile with referral info
  const updates = {};
  if (fullName) updates.full_name = fullName;
  if (referredBy) updates.referred_by = referredBy;
  if (Object.keys(updates).length) {
    await supabaseAdmin.from('profiles').update(updates).eq('id', user.id);
  }

  // Notify admin via Telegram
  await sendTelegramMessage(`🆕 New registration: ${email} (${fullName || 'No name'})`);

  return res.status(200).json({ user });
}

async function login(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (!rateLimit(`login_${ip}`, 5, 60000)) {
    return res.status(429).json({ error: 'Too many login attempts.' });
  }
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  // Check if banned or frozen
  const { data: profile } = await supabaseAdmin.from('profiles').select('is_banned,is_frozen').eq('id', data.user.id).single();
  if (profile?.is_banned) return res.status(403).json({ error: 'Account banned' });

  return res.status(200).json(data);
}

async function logout(req, res) {
  // Logout is handled client-side by removing token; we just return success
  return res.status(200).json({ message: 'Logged out' });
}

async function getProfile(req, res) {
  const user = await verifyUser(req);
  const { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
  return res.status(200).json(profile);
}

async function updateProfile(req, res) {
  const user = await verifyUser(req);
  const allowedFields = ['full_name', 'phone', 'username'];
  const updates = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  await supabaseAdmin.from('profiles').update(updates).eq('id', user.id);
  return res.status(200).json({ message: 'Profile updated' });
}

async function checkAdmin(req, res) {
  try {
    const user = await verifyUser(req);
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    return res.status(200).json({ is_admin: profile?.is_admin ?? false });
  } catch {
    return res.status(200).json({ is_admin: false });
  }
}
