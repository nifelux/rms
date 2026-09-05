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

// WAT (UTC+1) Weekend Check
function isTaskDayOpen() {
  const now = new Date();
  const watDate = new Date(now.getTime() + 60 * 60 * 1000);
  const day = watDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
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

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date, m0_start_date')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(500).json({ error: 'Failed to load profile' });
    }

    // 1. Check Weekend
    if (!isTaskDayOpen()) {
      return res.status(200).json({
        tier: profile.vip_level || 'newbie',
        boxes_opened: 0,
        max_boxes: 0,
        earning_per_box: 0,
        can_open: false,
        weekend_closed: true,
        message: 'Tasks are closed on Saturdays and Sundays. Come back Monday!'
      });
    }

    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    let boxesOpened = profile.boxes_opened_today || 0;
    if (lastReset < todayStart) {
      boxesOpened = 0;
      await supabaseAdmin.from('profiles').update({ 
        boxes_opened_today: 0, 
        last_task_reset_date: now.toISOString() 
      }).eq('id', user.id);
    }

    const tier = profile.vip_level || 'newbie';
    
    if (tier === 'newbie') {
      return res.status(200).json({ tier: 'newbie', boxes_opened: 0, max_boxes: 0, earning_per_box: 0, can_open: false });
    }

    if (tier === 'M0') {
      const m0StartDate = profile.m0_start_date ? new Date(profile.m0_start_date) : todayStart;
      const hoursSinceM0 = (now - m0StartDate) / (1000 * 60 * 60);
      if (hoursSinceM0 >= 24) {
        return res.status(200).json({ tier: 'M0', boxes_opened: 0, max_boxes: 0, earning_per_box: 0, can_open: false, m0_expired: true, message: 'Your free M0 trial has expired. Upgrade to continue.' });
      }
    }

    const { data: tierInfo, error: tierError } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, box_earning').eq('tier', tier).single();
    if (tierError || !tierInfo) return res.status(500).json({ error: 'Tier configuration not found' });

    return res.status(200).json({
      tier: tier,
      boxes_opened: boxesOpened,
      max_boxes: tierInfo.daily_boxes,
      earning_per_box: tierInfo.box_earning,
      can_open: boxesOpened < tierInfo.daily_boxes
    });
    
  } catch (err) {
    console.error('getTaskStatus error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function openMysteryBox(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    if (!isTaskDayOpen()) {
      return res.status(400).json({ error: 'Tasks are closed on weekends. Please try again on Monday.' });
    }

    const { data: profile, error: profileError } = await supabaseAdmin.from('profiles').select('vip_level, boxes_opened_today, last_task_reset_date, m0_start_date').eq('id', user.id).single();
    if (profileError || !profile) return res.status(500).json({ error: 'Profile not found' });

    const tier = profile.vip_level;
    if (!tier || tier === 'newbie') return res.status(400).json({ error: 'You must have an active tier to open boxes' });

    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    let boxesOpened = profile.boxes_opened_today || 0;
    
    if (lastReset < todayStart) boxesOpened = 0;

    if (tier === 'M0') {
      const m0StartDate = profile.m0_start_date ? new Date(profile.m0_start_date) : todayStart;
      const hoursSinceM0 = (now - m0StartDate) / (1000 * 60 * 60);
      if (hoursSinceM0 >= 24) return res.status(400).json({ error: 'Your M0 trial has expired. Please upgrade.' });
    }

    const { data: tierInfo, error: tierError } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, box_earning').eq('tier', tier).single();
    if (tierError || !tierInfo) return res.status(500).json({ error: 'Tier configuration not found' });

    if (boxesOpened >= tierInfo.daily_boxes) return res.status(400).json({ error: `Daily limit reached (${tierInfo.daily_boxes} boxes)` });

    const reference = `box_${user.id}_${Date.now()}`;
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, type: 'task_earning', amount: tierInfo.box_earning, status: 'approved', reference: reference, description: `Mystery Box Reward (${tier})`
    });

    if (txnErr) {
      if (txnErr.message.includes('duplicate')) return res.status(400).json({ error: 'Task already claimed' });
      return res.status(500).json({ error: txnErr.message });
    }

    await supabaseAdmin.from('profiles').update({ boxes_opened_today: boxesOpened + 1, last_task_reset_date: now.toISOString() }).eq('id', user.id);

    return res.status(200).json({ success: true, amount: tierInfo.box_earning, boxes_opened: boxesOpened + 1, max_boxes: tierInfo.daily_boxes });
    
  } catch (err) {
    console.error('openMysteryBox error:', err);
    return res.status(500).json({ error: err.message });
  }
}
