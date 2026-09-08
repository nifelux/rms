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
      .select('vip_level, boxes_opened_today, last_task_reset_date, newbie_boxes_claimed, newbie_start_date')
      .eq('id', user.id)
      .single();

    const tier = profile?.vip_level || 'newbie';

    // NEWBIE TIER: 1 box for 3 days, ₦50 per box
    if (tier === 'newbie' || tier === 'M0') {
      const now = new Date();
      const todayStart = startOfTodayWAT();
      const lastReset = profile?.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
      
      let boxesOpenedToday = profile?.boxes_opened_today || 0;
      if (lastReset < todayStart) {
        boxesOpenedToday = 0;
      }

      const newbieBoxesClaimed = profile?.newbie_boxes_claimed || 0;
      const newbieStartDate = profile?.newbie_start_date ? new Date(profile.newbie_start_date) : null;
      
      let canClaimMore = true;
      let daysRemaining = 3;
      
      if (newbieStartDate) {
        const daysSinceStart = Math.floor((now - newbieStartDate) / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, 3 - daysSinceStart);
        
        if (daysSinceStart >= 3) {
          canClaimMore = false;
        }
      }

      const maxBoxesToday = 1;
      const totalMaxBoxes = 3;
      
      return res.status(200).json({
        tier: 'NEWBIE',
        boxes_opened: boxesOpenedToday,
        max_boxes: maxBoxesToday,
        earning_per_box: 50,
        can_open: canClaimMore && boxesOpenedToday < maxBoxesToday && newbieBoxesClaimed < totalMaxBoxes,
        newbie_boxes_claimed: newbieBoxesClaimed,
        total_newbie_boxes: totalMaxBoxes,
        days_remaining: daysRemaining,
        message: !canClaimMore ? 'Newbie bonus period expired (3 days)' : 
                 newbieBoxesClaimed >= totalMaxBoxes ? 'All newbie boxes claimed' :
                 boxesOpenedToday >= maxBoxesToday ? 'Come back tomorrow for your next box' : 
                 'You can claim your daily newbie box!'
      });
    }

    // VIP TIERS (M1-M7)
    if (!isTaskDayOpen()) {
      return res.status(200).json({
        tier,
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

    const { data: tierInfo } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, daily_earning').eq('tier', tier).single();
    if (!tierInfo) return res.status(500).json({ error: 'Tier config not found' });

    return res.status(200).json({
      tier, boxes_opened: boxesOpened, max_boxes: tierInfo.daily_boxes, 
      daily_earning: tierInfo.daily_earning, 
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

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, boxes_opened_today, last_task_reset_date, newbie_boxes_claimed, newbie_start_date')
      .eq('id', user.id)
      .single();
      
    if (!profile) return res.status(500).json({ error: 'Profile not found' });

    const tier = profile.vip_level;
    const now = new Date();
    const todayStart = startOfTodayWAT();
    const lastReset = profile.last_task_reset_date ? new Date(profile.last_task_reset_date) : new Date(0);
    
    // NEWBIE TIER LOGIC
    if (tier === 'newbie' || tier === 'M0') {
      let boxesOpenedToday = profile.boxes_opened_today || 0;
      if (lastReset < todayStart) {
        boxesOpenedToday = 0;
      }

      const newbieBoxesClaimed = profile.newbie_boxes_claimed || 0;
      const newbieStartDate = profile.newbie_start_date ? new Date(profile.newbie_start_date) : null;
      
      if (newbieStartDate) {
        const daysSinceStart = Math.floor((now - newbieStartDate) / (1000 * 60 * 60 * 24));
        if (daysSinceStart >= 3) {
          return res.status(400).json({ error: 'Newbie bonus period expired (3 days)' });
        }
      }

      if (newbieBoxesClaimed >= 3) {
        return res.status(400).json({ error: 'You have claimed all your newbie boxes (3/3)' });
      }

      if (boxesOpenedToday >= 1) {
        return res.status(400).json({ error: 'You have already claimed your box for today. Come back tomorrow!' });
      }

      const boxAmount = 50;
      const reference = `newbie_box_${user.id.slice(0, 8)}_${Date.now()}`;
      
      const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
        user_id: user.id, 
        type: 'task_earning', 
        amount: boxAmount, 
        status: 'approved', 
        reference: reference, 
        description: `Newbie Mystery Box - Box ${newbieBoxesClaimed + 1}/3`
      });

      if (txnErr) return res.status(500).json({ error: txnErr.message });

      // ✅ FIXED: Use .update().eq() instead of .upsert()
      const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
      const newBalance = (wallet?.balance || 0) + boxAmount;
      
      await supabaseAdmin.from('wallets').update({ 
        balance: newBalance, 
        updated_at: new Date().toISOString() 
      }).eq('user_id', user.id);

      const updates = { 
        boxes_opened_today: boxesOpenedToday + 1, 
        last_task_reset_date: now.toISOString(),
        newbie_boxes_claimed: newbieBoxesClaimed + 1
      };
      
      if (!newbieStartDate) {
        updates.newbie_start_date = now.toISOString();
      }
      
      await supabaseAdmin.from('profiles').update(updates).eq('id', user.id);

      return res.status(200).json({ 
        success: true, 
        amount: boxAmount, 
        boxes_opened: boxesOpenedToday + 1, 
        max_boxes: 1,
        newbie_boxes_claimed: newbieBoxesClaimed + 1,
        total_newbie_boxes: 3,
        message: `Congratulations! ${boxAmount} added to your wallet.`
      });
    }

    // VIP TIERS (M1-M7)
    if (!isTaskDayOpen()) {
      return res.status(400).json({ error: 'Tasks closed on weekends.' });
    }

    if (!tier || tier === 'newbie' || tier === 'M0') {
      return res.status(400).json({ error: 'You must have an active VIP tier.' });
    }

    let boxesOpened = profile.boxes_opened_today || 0;
    if (lastReset < todayStart) boxesOpened = 0;

    const { data: tierInfo } = await supabaseAdmin.from('rms_tiers').select('daily_boxes, daily_earning').eq('tier', tier).single();
    if (!tierInfo) return res.status(500).json({ error: 'Tier config not found' });

    if (boxesOpened >= tierInfo.daily_boxes) {
      return res.status(400).json({ error: 'Daily limit reached.' });
    }

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
    
    if (boxesLeft === 1) {
      boxAmount = Math.max(0, remainingToday);
    } else {
      const avgRemaining = remainingToday / boxesLeft;
      const min = avgRemaining * 0.5;
      const max = avgRemaining * 1.5;
      
      boxAmount = Math.random() * (max - min) + min;
      boxAmount = Math.round(boxAmount * 100) / 100;
      
      const maxAllowed = remainingToday - (boxesLeft - 1); 
      if (boxAmount > maxAllowed) boxAmount = maxAllowed;
    }

    if (boxAmount <= 0 && remainingToday > 0) boxAmount = 1;

    const reference = `box_${user.id.slice(0, 8)}_${Date.now()}`;
    
    const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id, 
      type: 'task_earning', 
      amount: boxAmount, 
      status: 'approved', 
      reference: reference, 
      description: `Mystery Box Reward (${tier}) - Box ${boxesOpened + 1}/${tierInfo.daily_boxes}`
    });

    if (txnErr) return res.status(500).json({ error: txnErr.message });

    // ✅ FIXED: Use .update().eq() instead of .upsert()
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    const newBalance = (wallet?.balance || 0) + boxAmount;
    
    await supabaseAdmin.from('wallets').update({ 
      balance: newBalance, 
      updated_at: new Date().toISOString() 
    }).eq('user_id', user.id);

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
