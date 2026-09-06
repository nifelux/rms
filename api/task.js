import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getTaskStatus': return await getTaskStatus(req, res);
      case 'openMysteryBox': return await openMysteryBox(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Task API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// WAT (UTC+1) Helpers
function isTaskDayOpen() {
  const now = new Date();
  const watDate = new Date(now.getTime() + 60 * 60 * 1000);
  const day = watDate.getUTCDay(); 
  return day !== 0 && day !== 6; 
}

function startOfTodayWAT() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  wat.setUTCHours(0, 0, 0, 0);
  return new Date(wat.getTime() - 60 * 60 * 1000);
}

async function getTaskStatus(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    if (!isTaskDayOpen()) {
      return res.status(200).json({
        tier: profile?.vip_level || 'newbie',
        boxes_opened: 0, max_boxes: 0, earning_per_box: 0, can_open: false,
        weekend_closed: true, message: 'Tasks are closed on weekends. Come back Monday!'
      });
    }

    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile?.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    let boxesOpened = profile?.boxes_opened_today || 0;
    if (lastReset < todayStart) {
      boxesOpened = 0;
      await supabaseAdmin.from('profiles').update({ boxes_opened_today: 0, last_task_reset_date: now.toISOString() }).eq('id', user.id);
    }

    const tier = profile?.vip_level || 'newbie';
    if (tier === 'newbie' || tier === 'M0') {
      return res.status(200).json({ tier, boxes_opened: 0, max_boxes: 0, earning_per_box: 0, can_open: false });
    }

    const { data: tierInfo } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, daily_earning').eq('tier', tier).single();
    if (!tierInfo) return res.status(500).json({ error: 'Tier config not found' });

    return res.status(200).json({
      tier, boxes_opened, max_boxes: tierInfo.daily_boxes, 
      daily_earning: tierInfo.daily_earning, 
      can_open: boxesOpened < tierInfo.daily_boxes
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function openMysteryBox(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    if (!isTaskDayOpen()) return res.status(400).json({ error: 'Tasks closed on weekends.' });

    const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level, boxes_opened_today, last_task_reset_date').eq('id', user.id).single();
    if (!profile) return res.status(500).json({ error: 'Profile not found' });

    const tier = profile.vip_level;
    if (!tier || tier === 'newbie' || tier === 'M0') return res.status(400).json({ error: 'You must have an active VIP tier.' });

    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    let boxesOpened = profile.boxes_opened_today || 0;
    if (lastReset < todayStart) boxesOpened = 0;

    const { data: tierInfo } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, daily_earning').eq('tier', tier).single();
    if (!tierInfo) return res.status(500).json({ error: 'Tier config not found' });

    if (boxesOpened >= tierInfo.daily_boxes) return res.status(400).json({ error: 'Daily limit reached.' });

    // ==========================================
    // SMART RANDOMIZATION LOGIC
    // ==========================================
    
    // 1. Calculate how much they've already earned today
    const { data: todayTxns } = await supabaseAdmin
      .from('transactions')
      .select('amount')
      .eq('user_id', user.id)
      .eq('type', 'task_earning')
      .gte('created_at', todayStart.toISOString());

    const earnedToday = todayTxns ? todayTxns.reduce((sum, t) => sum + Number(t.amount), 0) : 0;
    const remainingToday = tierInfo.daily_earning - earnedToday;
    const boxesLeft = tierInfo.daily_boxes - boxesOpened;

    let boxAmount;
    
    // 2. If it's the last box, give the exact remainder to hit the daily target perfectly
    if (boxesLeft === 1) {
      boxAmount = remainingToday;
    } else {
      // 3. Otherwise, randomize between 50% and 150% of the average remaining per box
      const avgRemaining = remainingToday / boxesLeft;
      const min = avgRemaining * 0.5;
      const max = avgRemaining * 1.5;
      
      // Generate random float and round to 2 decimal places
      boxAmount = Math.random() * (max - min) + min;
      boxAmount = Math.round(boxAmount * 100) / 100;
      
      // Safety cap: ensure we don't overshoot the remaining total
      const maxAllowed = remainingToday - (boxesLeft - 1); 
      if (boxAmount > maxAllowed) boxAmount = maxAllowed;
    }

    // ==========================================
    // CREDIT WALLET & RECORD TRANSACTION
    // ==========================================

    const reference = `box_${user.id}_${Date.now()}`;
    
    // Record transaction
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, type: 'task_earning', amount: boxAmount, 
      status: 'approved', reference: reference, 
      description: `Mystery Box Reward (${tier}) - Box ${boxesOpened + 1}/${tierInfo.daily_boxes}`
    });

    if (txnErr) return res.status(500).json({ error: txnErr.message });

    // Credit Wallet
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    const newBalance = (wallet?.balance || 0) + boxAmount;
    
    await supabaseAdmin.from('wallets').upsert({
      user_id: user.id, balance: newBalance, updated_at: new Date()
    });

    // Update Profile Counters
    await supabaseAdmin.from('profiles').update({ 
      boxes_opened_today: boxesOpened + 1, 
      last_task_reset_date: now.toISOString() 
    }).eq('id', user.id);

    return res.status(200).json({ 
      success: true, 
      amount: boxAmount, 
      boxes_opened: boxesOpened + 1, 
      max_boxes: tierInfo.daily_boxes,
      daily_total: tierInfo.daily_earning
    });
    
  } catch (err) {
    console.error('openMysteryBox error:', err);
    return res.status(500).json({ error: err.message });
  }
}
