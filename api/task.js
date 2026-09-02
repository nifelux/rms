import supabaseAdmin from '../lib/supabase.js';

console.log('📦 Task API loaded');

export default async function handler(req, res) {
  console.log(' Request received:', req.method, req.url);
  console.log('📥 Query params:', req.query);
  
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action || req.body?.action;
  console.log('🎯 Action:', action);
  
  try {
    switch (action) {
      case 'getTaskStatus': 
        console.log('🔄 Calling getTaskStatus...');
        return await getTaskStatus(req, res);
      case 'openMysteryBox': 
        console.log('🔄 Calling openMysteryBox...');
        return await openMysteryBox(req, res);
      default: 
        console.log('❌ Invalid action:', action);
        return res.status(400).json({ error: 'Invalid action', received: action });
    }
  } catch (err) {
    console.error('💥 Task API Error:', err);
    console.error(' Error stack:', err.stack);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

function startOfTodayWAT() {
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  wat.setUTCHours(0, 0, 0, 0);
  return new Date(wat.getTime() - 60 * 60 * 1000);
}

async function getTaskStatus(req, res) {
  console.log('🔍 getTaskStatus called');
  
  try {
    // Get user from auth header
    const authHeader = req.headers.authorization;
    console.log('🔑 Auth header:', authHeader ? 'Present' : 'Missing');
    
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    console.log('🔑 Token length:', token.length);

    // Verify user
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    
    if (userError) {
      console.error('❌ User verification failed:', userError);
      return res.status(401).json({ error: 'Invalid token', details: userError.message });
    }
    
    if (!user) {
      console.error('❌ No user found in token');
      return res.status(401).json({ error: 'User not found' });
    }
    
    console.log('✅ User verified:', user.email);

    // Fetch profile
    console.log('📊 Fetching profile for user:', user.id);
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    if (profileError) {
      console.error('❌ Profile fetch error:', profileError);
      return res.status(500).json({ error: 'Failed to load profile', details: profileError.message });
    }

    console.log('✅ Profile loaded:', profile);

    // Daily reset logic
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    let boxesOpened = profile.boxes_opened_today || 0;
    if (lastReset < todayStart) {
      console.log('🔄 Resetting daily boxes (new day)');
      boxesOpened = 0;
      await supabaseAdmin.from('profiles').update({ 
        boxes_opened_today: 0, 
        last_task_reset_date: new Date().toISOString() 
      }).eq('id', user.id);
    }
// In the getTaskStatus function, add this check:

if (tier === 'M0') {
  // Check if M0 period has expired (1 day only)
  const m0StartDate = profile.m0_start_date ? new Date(profile.m0_start_date) : todayStart;
  const daysSinceM0 = Math.floor((now - m0StartDate) / (1000 * 60 * 60 * 24));
  
  if (daysSinceM0 >= 1) {
    return res.status(200).json({
      tier: 'M0',
      boxes_opened: 0,
      max_boxes: 0,
      earning_per_box: 0,
      can_open: false,
      m0_expired: true,
      message: 'Your free M0 trial has expired. Upgrade to continue earning.'
    });
  }

    // Fetch tier info
    const tier = profile.vip_level === 'newbie' ? null : profile.vip_level;
    let tierInfo = { daily_boxes: 0, box_earning: 0 };
    
    if (tier) {
      console.log(' Fetching tier info for:', tier);
      const { data: tierData, error: tierError } = await supabaseAdmin
        .from('rms_tiers')
        .select('*')
        .eq('tier', tier)
        .single();
      
      if (tierError) {
        console.error('❌ Tier fetch error:', tierError);
        return res.status(500).json({ error: 'Tier config not found', details: tierError.message });
      }
      
      if (tierData) {
        tierInfo = {
          daily_boxes: tierData.daily_boxes,
          box_earning: tierData.box_earning
        };
        console.log('✅ Tier info loaded:', tierInfo);
      }
    }

    const response = {
      tier: tier || 'newbie',
      boxes_opened: boxesOpened,
      max_boxes: tierInfo.daily_boxes,
      earning_per_box: tierInfo.box_earning,
      can_open: tier !== null && boxesOpened < tierInfo.daily_boxes
    };

    console.log('✅ Sending response:', response);
    return res.status(200).json(response);
    
  } catch (err) {
    console.error('💥 getTaskStatus error:', err);
    throw err;
  }
}

async function openMysteryBox(req, res) {
  console.log(' openMysteryBox called');
  
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('👤 User:', user.email);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    if (!profile || profile.vip_level === 'newbie') {
      return res.status(400).json({ error: 'Must upgrade to M-Tier' });
    }

    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    let boxesOpened = profile.boxes_opened_today || 0;
    
    if (lastReset < todayStart) boxesOpened = 0;

    const { data: tierInfo } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', profile.vip_level)
      .single();

    if (!tierInfo) {
      return res.status(500).json({ error: 'Tier config not found' });
    }

    if (boxesOpened >= tierInfo.daily_boxes) {
      return res.status(400).json({ error: 'Daily limit reached' });
    }

    // Credit wallet via transaction
    const reference = `box_${user.id}_${Date.now()}`;
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'task_earning',
      amount: tierInfo.box_earning,
      status: 'approved',
      reference: reference,
      description: `Mystery Box Reward (${profile.vip_level})`
    });

    if (txnErr) {
      console.error('❌ Transaction error:', txnErr);
      return res.status(500).json({ error: txnErr.message });
    }

    await supabaseAdmin.from('profiles').update({ 
      boxes_opened_today: boxesOpened + 1,
      last_task_reset_date: new Date().toISOString()
    }).eq('id', user.id);

    console.log('✅ Box opened successfully');
    return res.status(200).json({ 
      success: true, 
      amount: tierInfo.box_earning,
      boxes_opened: boxesOpened + 1
    });
    
  } catch (err) {
    console.error('💥 openMysteryBox error:', err);
    throw err;
  }
}
