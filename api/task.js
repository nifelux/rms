import supabaseAdmin from '../lib/supabase.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getAvailableTasks': return await getAvailableTasks(req, res);
      case 'completeTask': return await completeTask(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Task API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getAvailableTasks(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Get user profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, m0_task_days_completed, m0_start_date, last_task_date')
      .eq('id', user.id)
      .single();

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    // Check if user already did task today
    const { data: todayTask } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .eq('user_id', user.id)
      .eq('task_date', today)
      .single();

    if (todayTask) {
      return res.status(200).json({ 
        available: false, 
        message: 'You have already completed your task for today. Come back tomorrow!' 
      });
    }

    // M0 Logic: 1 task per day for 3 days only
    if (profile.vip_level === 'newbie' || profile.vip_level === 'M0') {
      let daysCompleted = profile.m0_task_days_completed || 0;
      const startDate = profile.m0_start_date;
      const lastTaskDate = profile.last_task_date;

      // If this is the first task ever
      if (!startDate) {
        return res.status(200).json({ 
          available: true, 
          amount: 50,
          message: 'M0 Task (Day 1 of 3)',
          daysRemaining: 3
        });
      }

      // Check if last task was yesterday or earlier
      const lastDate = lastTaskDate ? new Date(lastTaskDate) : null;
      const todayDate = new Date(today);
      
      if (lastDate) {
        const daysDiff = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
        if (daysDiff < 1) {
          return res.status(200).json({ 
            available: false, 
            message: 'You already did your task today. Come back tomorrow!' 
          });
        }
      }

      // Check if 3 days limit reached
      if (daysCompleted >= 3) {
        return res.status(200).json({ 
          available: false, 
          message: 'You have completed all 3 M0 tasks. Please upgrade to M1 to continue earning!' 
        });
      }

      const daysRemaining = 3 - daysCompleted;
      return res.status(200).json({ 
        available: true, 
        amount: 50,
        message: `M0 Task (Day ${daysCompleted + 1} of 3)`,
        daysRemaining: daysRemaining
      });
    }

    // M1+ users get more tasks (you can customize this)
    return res.status(200).json({ 
      available: true, 
      amount: 100,
      message: 'VIP Task Available',
      isVip: true
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

    const today = new Date().toISOString().split('T')[0];

    // Check if already completed today
    const { data: existingTask } = await supabaseAdmin
      .from('tasks')
      .select('id')
      .eq('user_id', user.id)
      .eq('task_date', today)
      .single();

    if (existingTask) {
      return res.status(400).json({ error: 'Task already completed today' });
    }

    // Get user profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('vip_level, m0_task_days_completed, m0_start_date')
      .eq('id', user.id)
      .single();

    // M0 Logic
    if (profile.vip_level === 'newbie' || profile.vip_level === 'M0') {
      const daysCompleted = profile.m0_task_days_completed || 0;
      
      if (daysCompleted >= 3) {
        return res.status(400).json({ error: 'M0 task limit reached. Upgrade to M1 to continue.' });
      }

      const taskAmount = 50;

      // Create task record
      await supabaseAdmin.from('tasks').insert({
        user_id: user.id,
        amount: taskAmount,
        status: 'completed',
        task_date: today,
        completed_at: new Date()
      });

      // Update profile
      const newDaysCompleted = daysCompleted + 1;
      const updateData = {
        m0_task_days_completed: newDaysCompleted,
        last_task_date: today
      };
      
      if (!profile.m0_start_date) {
        updateData.m0_start_date = new Date();
      }

      await supabaseAdmin.from('profiles').update(updateData).eq('id', user.id);

      // Credit wallet
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .single();

      const newBalance = (wallet?.balance || 0) + taskAmount;
      await supabaseAdmin.from('wallets').upsert({
        user_id: user.id,
        balance: newBalance,
        updated_at: new Date()
      });

      // Record transaction
      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'task_earning',
        amount: taskAmount,
        status: 'approved',
        reference: `task_${Date.now()}`,
        description: `M0 Task Day ${newDaysCompleted}/3`
      });

      return res.status(200).json({ 
        success: true, 
        message: `Task completed! ₦${taskAmount} added to your wallet.`,
        daysCompleted: newDaysCompleted,
        daysRemaining: 3 - newDaysCompleted
      });
    }

    // M1+ users (you can add different logic here)
    return res.status(400).json({ error: 'Task system for VIP users coming soon' });

  } catch (err) {
    console.error('Complete task error:', err);
    return res.status(500).json({ error: err.message });
  }
}
