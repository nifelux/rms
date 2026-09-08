import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'invest': return await invest(req, res);
      case 'claim': return await claimInvestment(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Wealth API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function invest(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    // Accept both package_id (new) and plan_id (old) for backward compatibility
    const { package_id, plan_id, amount, plan_name, daily_return, duration_days, return_amount } = req.body;
    const investAmount = Number(amount);
    const pkgId = package_id || plan_id;

    if (!pkgId || !investAmount || investAmount <= 0) {
      return res.status(400).json({ error: 'Invalid investment details' });
    }

    // 1. Get Package Details from wealth_packages table
    const { data: pkg, error: pkgError } = await supabaseAdmin
      .from('wealth_packages')
      .select('*')
      .eq('id', pkgId)
      .single();

    if (pkgError || !pkg) {
      return res.status(404).json({ error: 'Wealth package not found' });
    }

    // 2. Check if package is active
    if (!pkg.is_active) {
      return res.status(400).json({ error: 'This package is no longer available' });
    }

    // 3. Check date availability (start_date and end_date)
    const now = new Date();
    const startDate = pkg.start_date ? new Date(pkg.start_date) : null;
    const endDate = pkg.end_date ? new Date(pkg.end_date + 'T23:59:59') : null;

    if (startDate && now < startDate) {
      return res.status(400).json({ error: `This package starts on ${startDate.toLocaleDateString()}. Please wait.` });
    }
    if (endDate && now > endDate) {
      return res.status(400).json({ error: `This package expired on ${endDate.toLocaleDateString()}.` });
    }

    // 4. Validate amount matches package
    if (investAmount !== Number(pkg.investment_amount)) {
      return res.status(400).json({ error: 'Amount does not match package requirement' });
    }

    // 5. Check Balance
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (walletError || !wallet) {
      return res.status(400).json({ error: 'Wallet not found' });
    }

    if (Number(wallet.balance) < investAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // 6. Deduct Balance
    const newBalance = Number(wallet.balance) - investAmount;
    await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('user_id', user.id);

    // 7. Calculate total return if not provided
    const totalReturn = return_amount ? Number(return_amount) : (Number(pkg.total_return) || (Number(pkg.daily_return) * Number(pkg.duration_days)));
    const dailyReturn = daily_return ? Number(daily_return) : Number(pkg.daily_return);
    const duration = duration_days ? Number(duration_days) : Number(pkg.duration_days);
    const packageName = plan_name || pkg.name;

    // 8. Save Investment
    const { data: investment, error: invError } = await supabaseAdmin
      .from('wealth_investments')
      .insert({
        user_id: user.id,
        plan_id: pkg.id, // Keep plan_id for backward compatibility
        plan_name: packageName,
        amount: investAmount,
        return_amount: totalReturn,
        daily_return: dailyReturn,
        duration_days: duration,
        status: 'active',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (invError) {
      // Rollback if save fails
      await supabaseAdmin
        .from('wallets')
        .update({ balance: Number(wallet.balance), updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      return res.status(500).json({ error: 'Failed to save investment: ' + invError.message });
    }

    // 9. Record Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_invest',
      amount: investAmount,
      status: 'approved',
      reference: `inv_${investment.id}`,
      description: `Invested in ${packageName}`,
      created_at: new Date().toISOString()
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Investment successful', 
      newBalance,
      investment 
    });

  } catch (err) {
    console.error('Invest error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function claimInvestment(req, res) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No authorization' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { investment_id } = req.body;

    // 1. Get the investment
    const { data: inv, error: invError } = await supabaseAdmin
      .from('wealth_investments')
      .select('*')
      .eq('id', investment_id)
      .eq('user_id', user.id)
      .single();

    if (invError || !inv) {
      return res.status(404).json({ error: 'Investment not found' });
    }

    if (inv.status !== 'active') {
      return res.status(400).json({ error: 'Investment already claimed or inactive' });
    }

    // 2. Check Maturity
    const startDate = new Date(inv.created_at);
    const maturityDate = new Date(startDate);
    const durationMs = inv.duration_days * 24 * 60 * 60 * 1000; 
    maturityDate.setTime(startDate.getTime() + durationMs);

    if (new Date() < maturityDate) {
      const remainingMins = Math.ceil((maturityDate - new Date()) / 60000);
      const remainingDays = Math.floor(remainingMins / 1440);
      const remainingHours = Math.floor((remainingMins % 1440) / 60);
      const remainingMinutes = remainingMins % 60;
      
      let timeLeft = '';
      if (remainingDays > 0) timeLeft += `${remainingDays}d `;
      if (remainingHours > 0) timeLeft += `${remainingHours}h `;
      if (remainingMinutes > 0) timeLeft += `${remainingMinutes}m`;
      
      return res.status(400).json({ 
        error: `Not matured yet. Wait ${timeLeft || remainingMins + ' minutes'} more.` 
      });
    }

    // 3. Credit Wallet
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    const newBalance = Number(wallet.balance) + Number(inv.return_amount);
    await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('user_id', user.id);

    // 4. Mark as Completed
    await supabaseAdmin
      .from('wealth_investments')
      .update({ 
        status: 'completed', 
        completed_at: new Date().toISOString() 
      })
      .eq('id', investment_id);

    // 5. Record Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_claim',
      amount: inv.return_amount,
      status: 'approved',
      reference: `claim_${inv.id}`,
      description: `Claimed returns from ${inv.plan_name}`,
      created_at: new Date().toISOString()
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Claimed successfully!', 
      newBalance 
    });

  } catch (err) {
    console.error('Claim error:', err);
    return res.status(500).json({ error: err.message });
  }
}
