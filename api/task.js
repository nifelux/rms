/**
 * RMS Task API — Mystery Box System
 * Actions: getTaskStatus, openMysteryBox
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getTaskStatus': return await getTaskStatus(req, res);
      case 'openMysteryBox': return await openMysteryBox(req, res);
      default: 
        return res.status(400).json({ error: 'Invalid action', received: action });
    }
  } catch (err) {
    console.error('Task API Error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// ... rest of your functions
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

function startOfTodayWAT() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  wat.setUTCHours(0, 0, 0, 0);
  return new Date(wat.getTime() - 60 * 60 * 1000);
}

async function getTaskStatus(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error('Profile fetch error:', profileError);
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    let boxesOpened = profile.boxes_opened_today || 0;
    if (lastReset < todayStart) {
      boxesOpened = 0;
      await supabaseAdmin.from('profiles').update({ 
        boxes_opened_today: 0, 
        last_task_reset_date: new Date().toISOString() 
      }).eq('id', user.id);
    }

    const tier = profile.vip_level === 'newbie' ? null : profile.vip_level;
    let tierInfo = { daily_boxes: 0, box_earning: 0 };
    
    if (tier) {
      const { data: tierData, error: tierError } = await supabaseAdmin
        .from('rms_tiers')
        .select('*')
        .eq('tier', tier)
        .single();
      
      if (tierError) {
        console.error('Tier fetch error:', tierError);
        return res.status(500).json({ 
          error: 'Tier configuration not found. Database migration may be required.',
          debug: tierError.message 
        });
      }
      
      if (tierData) {
        tierInfo = {
          daily_boxes: tierData.daily_boxes,
          box_earning: tierData.box_earning
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
  } catch (err) {
    console.error('getTaskStatus error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function openMysteryBox(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) return res.status(404).json({ error: 'Profile not found.' });

    const tier = profile.vip_level;
    if (tier === 'newbie' || !tier) {
      return res.status(400).json({ error: 'You must upgrade to an M-Tier to open Mystery Boxes.' });
    }

    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    let boxesOpened = profile.boxes_opened_today || 0;
    
    if (lastReset < todayStart) boxesOpened = 0;

    const { data: tierInfo, error: tierError } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', tier)
      .single();

    if (tierError || !tierInfo) return res.status(500).json({ error: 'Tier configuration not found.' });

    if (boxesOpened >= tierInfo.daily_boxes) {
      return res.status(400).json({ error: `You have reached your daily limit of ${tierInfo.daily_boxes} boxes.` });
    }

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
      if (txnErr.message.includes('duplicate')) return res.status(400).json({ error: 'Task already claimed.' });
      return res.status(500).json({ error: txnErr.message });
    }

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
  } catch (err) {
    console.error('openMysteryBox error:', err);
    return res.status(500).json({ error: err.message });
  }
}
