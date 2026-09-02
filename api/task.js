/**
 * RMS Task API — Mystery Box System
 * Actions: getTaskStatus, openMysteryBox
 */
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
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// Helper: Get start of today in WAT (UTC+1) for accurate daily resets
function startOfTodayWAT() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  wat.setUTCHours(0, 0, 0, 0);
  return new Date(wat.getTime() - 60 * 60 * 1000); // Convert back to UTC for DB
}

async function getTaskStatus(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // 1. Fetch Profile
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('vip_level, boxes_opened_today, last_task_reset_date')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // 2. Daily Reset Logic
  const todayStart = startOfTodayWAT();
  const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
  
  let boxesOpened = profile.boxes_opened_today || 0;
  if (lastReset < todayStart) {
    // It's a new day, reset the counter
    boxesOpened = 0;
    await supabaseAdmin.from('profiles').update({ 
      boxes_opened_today: 0, 
      last_task_reset_date: new Date().toISOString() 
    }).eq('id', user.id);
  }

  // 3. Fetch Tier Info
  const tier = profile.vip_level === 'newbie' ? null : profile.vip_level;
  let tierInfo = { daily_boxes: 0, box_earning: 0, upgrade_cost: 0 };
  
  if (tier) {
    const { data: tierData } = await supabaseAdmin
      .from('rms_tiers')
      .select('*')
      .eq('tier', tier)
      .single();
    
    if (tierData) {
      tierInfo = {
        daily_boxes: tierData.daily_boxes,
        box_earning: tierData.box_earning,
        upgrade_cost: tierData.upgrade_cost
      };
    }
  }

  return res.status(200).json({
    tier: tier || 'newbie',
    boxes_opened: boxesOpened,
    max_boxes: tierInfo.daily_boxes,
    earning_per_box: tierInfo.box_earning,
    can_open: tier !== null && boxesOpened < tierInfo.daily_boxes
  });
}

async function openMysteryBox(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // 1. Fetch Profile & Tier
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('vip_level, boxes_opened_today, last_task_reset_date')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const tier = profile.vip_level;
  if (tier === 'newbie' || !tier) {
    return res.status(400).json({ error: 'You must upgrade to an M-Tier to open Mystery Boxes.' });
  }

  // 2. Check Daily Reset
  const todayStart = startOfTodayWAT();
  const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
  let boxesOpened = profile.boxes_opened_today || 0;
  
  if (lastReset < todayStart) {
    boxesOpened = 0;
  }

  // 3. Fetch Tier Limits
  const { data: tierInfo } = await supabaseAdmin
    .from('rms_tiers')
    .select('daily_boxes, box_earning')
    .eq('tier', tier)
    .single();

  if (!tierInfo) return res.status(500).json({ error: 'Tier configuration not found' });

  // 4. Validate Limit
  if (boxesOpened >= tierInfo.daily_boxes) {
    return res.status(400).json({ error: `You have reached your daily limit of ${tierInfo.daily_boxes} boxes.` });
  }

  // 5. Credit Wallet (via Transaction Trigger)
  const reference = `box_${user.id}_${Date.now()}`;
  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'task_earning',
    amount: tierInfo.box_earning,
    status: 'approved',
    reference: reference,
    description: `Mystery Box Reward (${tier})`
  });

  if (txnErr) {
    // Handle unique constraint violation if somehow triggered twice
    if (txnErr.message.includes('duplicate')) {
      return res.status(400).json({ error: 'Task already claimed.' });
    }
    return res.status(500).json({ error: txnErr.message });
  }

  // 6. Increment Box Count & Update Reset Date
  await supabaseAdmin.from('profiles').update({ 
    boxes_opened_today: boxesOpened + 1,
    last_task_reset_date: new Date().toISOString()
  }).eq('id', user.id);

  return res.status(200).json({ 
    success: true, 
    amount: tierInfo.box_earning,
    boxes_opened: boxesOpened + 1,
    max_boxes: tierInfo.daily_boxes
  });
}
