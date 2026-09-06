import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getTaskStatus': return await getTaskStatus(req, res);
      case 'openMysteryBox': return await openMysteryBox(req, res);
      case 'getAvailableTasks': return await getAvailableTasks(req, res);
      case 'completeTask': return await completeTask(req, res);
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

// ====== OLD API FUNCTIONS (Enhanced) ======

async function getTaskStatus(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date, m0_start_date, m0_task_days_completed')
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
    
    // M0 Logic
    if (tier === 'newbie' || tier === 'M0') {
      const m0Completed = profile.m0_task_days_completed || 0;
      
      if (m0Completed >= 3) {
        return res.status(200).json({ 
          tier: 'M0', 
          boxes_opened: 0, 
          max_boxes: 0, 
          earning_per_box: 0, 
          can_open: false,
          m0_expired: true, 
          message: 'Your 3 M0 tasks are complete. Upgrade to M1 to continue.' 
        });
      }
      
      // Check if already did today's task
      const lastTaskDate = profile.last_task_reset_date ? new Date(profile.last_task_reset_date).toISOString().split('T')[0] : null;
      const today = now.toISOString().split('T')[0];
      
      if (lastTaskDate === today) {
        return res.status(200).json({
          tier: 'M0',
          boxes_opened: 1,
          max_boxes: 1,
          earning_per_box: 50,
          can_open: false,
          message: 'You already completed today\'s M0 task. Come back tomorrow!'
        });
      }
      
      return res.status(200).json({
        tier: 'M0',
        boxes_opened: 0,
        max_boxes: 1,
        earning_per_box: 50,
        can_open: true,
        m0_day: m0Completed + 1,
        m0_total: 3
      });
    }

    // M1+ Logic - Fetch from rms_tiers
    const { data: tierInfo, error: tierError } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', tier)
      .single();
      
    if (tierError || !tierInfo) {
      // Fallback defaults
      const defaults = { 'M1': { daily_boxes: 5, box_earning: 100 }, 'M2': { daily_boxes: 10, box_earning: 200 } };
      tierInfo = defaults[tier] || { daily_boxes: 5, box_earning: 100 };
    }

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

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date, m0_start_date, m0_task_days_completed')
      .eq('id', user.id)
      .single();
      
    if (profileError || !profile) return res.status(500).json({ error: 'Profile not found' });

    const tier = profile.vip_level;
    if (!tier || tier === 'newbie') return res.status(400).json({ error: 'You must have an active tier to open boxes' });

    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    let boxesOpened = profile.boxes_opened_today || 0;
    
    if (lastReset < todayStart) boxesOpened = 0;

    // M0 Logic
    if (tier === 'M0') {
      const m0Completed = profile.m0_task_days_completed || 0;
      
      if (m0Completed >= 3) {
        return res.status(400).json({ error: 'Your 3 M0 tasks are complete. Upgrade to M1.' });
      }
      
      // Check if already did today
      const lastTaskDate = profile.last_task_reset_date ? new Date(profile.last_task_reset_date).toISOString().split('T')[0] : null;
      const today = now.toISOString().split('T')[0];
      
      if (lastTaskDate === today) {
        return res.status(400).json({ error: 'You already completed today\'s M0 task.' });
      }
      
      boxesOpened = 0; // M0 shows 0/1 each day
    }

    // M1+ - Fetch tier config
    const { data: tierInfo, error: tierError } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', tier)
      .single();
      
    const earning = tier === 'M0' ? 50 : (tierInfo?.box_earning || 100);
    const maxBoxes = tier === 'M0' ? 1 : (tierInfo?.daily_boxes || 5);

    if (boxesOpened >= maxBoxes) {
      return res.status(400).json({ error: `Daily limit reached (${maxBoxes} boxes)` });
    }

    // Create transaction with duplicate check
    const reference = `box_${user.id}_${Date.now()}`;
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, 
      type: 'task_earning', 
      amount: earning, 
      status: 'approved', 
      reference: reference, 
      description: `Mystery Box Reward (${tier})`
    });

    if (txnErr) {
      if (txnErr.message.includes('duplicate')) return res.status(400).json({ error: 'Task already claimed' });
      return res.status(500).json({ error: txnErr.message });
    }

    // Update profile
    const updateData = { 
      boxes_opened_today: boxesOpened + 1, 
      last_task_reset_date: now.toISOString() 
    };
    
    if (tier === 'M0') {
      const m0Completed = profile.m0_task_days_completed || 0;
      updateData.m0_task_days_completed = m0Completed + 1;
    }
    
    await supabaseAdmin.from('profiles').update(updateData).eq('id', user.id);

    return res.status(200).json({ 
      success: true, 
      amount: earning, 
      boxes_opened: boxesOpened + 1, 
      max_boxes: maxBoxes 
    });
    
  } catch (err) {
    console.error('openMysteryBox error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ====== NEW API FUNCTIONS (Enhanced with old features) ======

async function getAvailableTasks(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Check weekend
    if (!isTaskDayOpen()) {
      return res.status(200).json({ 
        available: false, 
        weekend_closed: true,
        message: 'Tasks closed on weekends. Come back Monday!' 
      });
    }

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, m0_task_days_completed, m0_start_date, last_task_date, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    const today = new Date().toISOString().split('T')[0];
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    // Reset if new day
    if (lastReset < todayStart) {
      await supabaseAdmin.from('profiles').update({ 
        boxes_opened_today: 0, 
        last_task_reset_date: new Date().toISOString() 
      }).eq('id', user.id);
    }

    const vipLevel = profile.vip_level || 'newbie';
    
    // M0 Logic
    if (vipLevel === 'newbie' || vipLevel === 'M0') {
      const daysCompleted = profile.m0_task_days_completed || 0;
      const lastTaskDate = profile.last_task_date || (profile.last_task_reset_date ? new Date(profile.last_task_reset_date).toISOString().split('T')[0] : null);

      if (daysCompleted >= 3) {
        return res.status(200).json({ 
          available: false, 
          m0_complete: true,
          message: 'All 3 M0 tasks completed. Upgrade to M1!' 
        });
      }

      if (lastTaskDate === today) {
        return res.status(200).json({ 
          available: false, 
          message: 'You already did today\'s task. Come back tomorrow!' 
        });
      }

      return res.status(200).json({ 
        available: true, 
        amount: 50,
        message: `M0 Task (Day ${daysCompleted + 1} of 3)`,
        daysRemaining: 3 - daysCompleted,
        is_m0: true
      });
    }

    // M1+ Logic
    const { data: tierInfo } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', vipLevel)
      .single();
      
    const maxBoxes = tierInfo?.daily_boxes || 5;
    const earning = tierInfo?.box_earning || 100;
    const boxesOpened = profile.boxes_opened_today || 0;

    if (boxesOpened >= maxBoxes) {
      return res.status(200).json({ 
        available: false, 
        message: `Daily limit reached (${maxBoxes} boxes)` 
      });
    }

    return res.status(200).json({ 
      available: true, 
      amount: earning,
      message: `${maxBoxes - boxesOpened} boxes remaining`,
      boxes_opened: boxesOpened,
      max_boxes: maxBoxes,
      is_vip: true
    });

  } catch (err) {
    console.error('Get tasks error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function completeTask(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    if (!isTaskDayOpen()) {
      return res.status(400).json({ error: 'Tasks closed on weekends' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now = new Date();

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, m0_task_days_completed, boxes_opened_today, last_task_reset_date')
      .eq('id', user.id)
      .single();

    const vipLevel = profile.vip_level || 'newbie';
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    // Reset if new day
    if (lastReset < todayStart) {
      await supabaseAdmin.from('profiles').update({ 
        boxes_opened_today: 0, 
        last_task_reset_date: now.toISOString() 
      }).eq('id', user.id);
      profile.boxes_opened_today = 0;
    }

    // M0 Logic
    if (vipLevel === 'newbie' || vipLevel === 'M0') {
      const daysCompleted = profile.m0_task_days_completed || 0;
      
      if (daysCompleted >= 3) {
        return res.status(400).json({ error: 'M0 tasks complete. Upgrade to M1.' });
      }

      const taskAmount = 50;
      const reference = `task_${user.id}_${Date.now()}`;

      // Create task & transaction
      await supabaseAdmin.from('tasks').insert({
        user_id: user.id,
        amount: taskAmount,
        status: 'completed',
        task_date: today,
        completed_at: new Date()
      });

      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'task_earning',
        amount: taskAmount,
        status: 'approved',
        reference: reference,
        description: `M0 Task Day ${daysCompleted + 1}/3`
      });

      // Update profile
      await supabaseAdmin.from('profiles').update({
        m0_task_days_completed: daysCompleted + 1,
        boxes_opened_today: 1,
        last_task_reset_date: now.toISOString(),
        last_task_date: today
      }).eq('id', user.id);

      // Credit wallet
      const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
      await supabaseAdmin.from('wallets').upsert({
        user_id: user.id,
        balance: (wallet?.balance || 0) + taskAmount,
        updated_at: new Date()
      });

      return res.status(200).json({ 
        success: true, 
        amount: taskAmount,
        message: `₦${taskAmount} added! Day ${daysCompleted + 1}/3 complete.`,
        daysCompleted: daysCompleted + 1
      });
    }

    // M1+ Logic
    const { data: tierInfo } = await supabaseAdmin
      .from('rms_tiers')
      .select('daily_boxes, box_earning')
      .eq('tier', vipLevel)
      .single();
      
    const maxBoxes = tierInfo?.daily_boxes || 5;
    const earning = tierInfo?.box_earning || 100;
    const boxesOpened = profile.boxes_opened_today || 0;

    if (boxesOpened >= maxBoxes) {
      return res.status(400).json({ error: 'Daily limit reached' });
    }

    const reference = `task_${user.id}_${Date.now()}`;

    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'task_earning',
      amount: earning,
      status: 'approved',
      reference: reference,
      description: `${vipLevel} Mystery Box`
    });

    await supabaseAdmin.from('profiles').update({
      boxes_opened_today: boxesOpened + 1,
      last_task_reset_date: now.toISOString()
    }).eq('id', user.id);

    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    await supabaseAdmin.from('wallets').upsert({
      user_id: user.id,
      balance: (wallet?.balance || 0) + earning,
      updated_at: new Date()
    });

    return res.status(200).json({ 
      success: true, 
      amount: earning,
      boxes_opened: boxesOpened + 1,
      max_boxes: maxBoxes
    });

  } catch (err) {
    console.error('Complete task error:', err);
    return res.status(500).json({ error: err.message });
  }
}
