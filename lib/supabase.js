/**
 * Supabase Service Role Client
 * Used in serverless functions to bypass RLS.
 * Must never be exposed to the frontend.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default supabaseAdmin;
