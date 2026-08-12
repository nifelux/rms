/**
 * Supabase Client Initialization
 * Uses anon key for frontend operations (RLS enforced).
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const supabase = createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
window.supabase = supabase;
export default supabase;
