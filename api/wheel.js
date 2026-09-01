import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  try {
    switch (action) {
      case 'getSpinStatus': return await getSpinStatus(req, res);
      case 'spin': return await spin(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getSpinStatus(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // 1. Count Active Downlines (Referrals with at least one approved deposit)
  const { data: referrals } = await supabaseAdmin.from('profiles').select('id').eq('referred_by', user.id);
  let activeDownlines = 0;
  if (referrals && referrals.length > 0) {
    const refIds = referrals.map(r => r.id);
    const { count } = await supabaseAdmin.from('deposits').select('*', { count: 'exact', head: true })
      .in('user_id', refIds).eq('status', 'approved');
    activeDownlines = count || 0;
  }

  // 2. Count Spins Used Today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { count: spinsUsed } = await supabaseAdmin.from('wheel_logs').select('*', { count: 'exact', head: true })
    .eq('user_id', user.id).gte('created_at', today.toISOString());

  return res.status(200).json({
    allowed_spins: activeDownlines,
    spins_used: spinsUsed || 0,
    spins_remaining: Math.max(0, activeDownlines - (spinsUsed || 0))
  });
}

async function spin(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { allowed_spins, spins_used } = (await getSpinStatus({ headers: req.headers }, { status: () => ({ json: () => ({}) }) })).body || {}; 
  // Note: In production, re-fetch status cleanly. For brevity, we assume frontend checks status first.
  const { data: status } = await supabaseAdmin.from('profiles').select('id').eq('id', user.id).single();
  
  const today = new Date(); today.setHours(0,0,0,0);
  const { count: spinsUsed } = await supabaseAdmin.from('wheel_logs').select('*', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', today.toISOString());
  const { data: referrals } = await supabaseAdmin.from('profiles').select('id').eq('referred_by', user.id);
  let active = 0;
  if(referrals) {
      const { count } = await supabaseAdmin.from('deposits').select('*', {count:'exact', head:true}).in('user_id', referrals.map(r=>r.id)).eq('status','approved');
      active = count || 0;
  }
  
  if (spinsUsed >= active) return res.status(400).json({ error: 'No spins remaining today.' });

  // 3. Determine Prize (Simple weighted random)
  const prizes = [0, 100, 200, 500, 1000, 2000]; 
  const prize = prizes[Math.floor(Math.random() * prizes.length)];

  // 4. Log Spin
  await supabaseAdmin.from('wheel_logs').insert({ user_id: user.id, prize_amount: prize });

  // 5. Credit if won
  if (prize > 0) {
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id, type: 'wheel_win', amount: prize, status: 'approved',
      reference: `wheel_${Date.now()}`, description: 'Lucky Wheel Win'
    });
  }

  return res.status(200).json({ success: true, prize_amount: prize });
                                                        }
