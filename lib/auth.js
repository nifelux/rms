/**
 * Authentication Middleware for API Routes
 * Verifies JWT from Authorization header and checks admin status.
 */
import supabaseAdmin from './supabase.js';

export async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    throw new Error('Invalid token');
  }
  return user;
}

export async function verifyAdmin(req) {
  const user = await verifyUser(req);
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();
  if (error || !profile || !profile.is_admin) {
    throw new Error('Admin access required');
  }
  return user;
}
