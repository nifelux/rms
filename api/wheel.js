import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getWheelConfig': return await getWheelConfig(req, res);
      case 'spinWheel': return await spinWheel(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Wheel API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getWheelConfig(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('wheel_spins, vip_level')
      .eq('id', user.id)
      .single();

    let { data: wheelConfigs } = await supabaseAdmin
      .from('wheel_configs')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    return res.status(200).json({
      wheel_spins: profile?.wheel_spins || 0,
      configs: wheelConfigs || []
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function spinWheel(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('wheel_spins')
      .eq('id', user.id)
      .single();

    if (!profile || profile.wheel_spins < 1) {
      return res.status(400).json({ error: 'No spins available!' });
    }

    // 1. Calculate Team Score
    const { data: referrals } = await supabaseAdmin
      .from('profiles')
      .select('vip_level')
      .eq('referred_by', user.id);

    const tierPoints = { 'M0': 1, 'M1': 5, 'M2': 15, 'M3': 30, 'M4': 50, 'M5': 80, 'M6': 100, 'M7': 150 };
    let teamScore = 0;
    if (referrals) referrals.forEach(r => { teamScore += (tierPoints[r.vip_level] || 0); });

    // 2. Get Configs
    let { data: wheelConfigs } = await supabaseAdmin
      .from('wheel_configs')
      .select('*')
      .eq('is_active', true);

    // 3. STRICT PROBABILITY FILTERING
    // If team score is low, they CANNOT win high amounts.
    let availableConfigs = wheelConfigs.filter(c => {
      if (c.prize_amount === 0) return true; // Always allow Try Again
      
      if (teamScore < 10) return c.prize_amount <= 500;       // Only 300, 500
      if (teamScore < 30) return c.prize_amount <= 1000;      // Up to 1000
      if (teamScore < 60) return c.prize_amount <= 2000;      // Up to 2000
      if (teamScore < 100) return c.prize_amount <= 5000;     // Up to 5000
      return true; // Elite team can win anything
    });

    // 4. Determine Winner based on weights
    const totalWeight = availableConfigs.reduce((sum, c) => sum + c.weight, 0);
    let random = Math.random() * totalWeight;
    let winner = availableConfigs[availableConfigs.length - 1];

    for (const config of availableConfigs) {
      random -= config.weight;
      if (random <= 0) {
        winner = config;
        break;
      }
    }

    // 5. Deduct Spin
    await supabaseAdmin
      .from('profiles')
      .update({ wheel_spins: profile.wheel_spins - 1, updated_at: new Date() })
      .eq('id', user.id);

    // 6. Credit Wallet (FIXED: Using SELECT then UPDATE to prevent upsert errors)
    if (winner.prize_amount > 0) {
      const { data: wallet, error: walletErr } = await supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .single();

      if (walletErr || !wallet) {
        // Create wallet if missing
        await supabaseAdmin.from('wallets').insert({ user_id: user.id, balance: winner.prize_amount });
      } else {
        // Update existing wallet
        await supabaseAdmin
          .from('wallets')
          .update({ balance: Number(wallet.balance) + Number(winner.prize_amount), updated_at: new Date() })
          .eq('user_id', user.id);
      }

      // Record Transaction
      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'wheel_win',
        amount: winner.prize_amount,
        status: 'approved',
        reference: `wheel_${Date.now()}`,
        description: `Lucky Wheel Win (Score: ${teamScore})`
      });
    } else {
      // Record Try Again Transaction (0 amount)
      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'wheel_spin',
        amount: 0,
        status: 'approved',
        reference: `wheel_${Date.now()}`,
        description: `Lucky Wheel - Try Again`
      });
    }

    return res.status(200).json({
      success: true,
      prize: winner.prize_amount,
      is_try_again: winner.prize_amount === 0,
      segment_id: winner.id,
      spins_remaining: profile.wheel_spins - 1
    });

  } catch (err) {
    console.error('Spin error:', err);
    return res.status(500).json({ error: err.message });
  }
}
