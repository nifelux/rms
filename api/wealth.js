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

    const { plan_id, amount } = req.body;
    const investAmount = Number(amount);

    if (!plan_id || !investAmount || investAmount <= 0) {
      return res.status(400).json({ error: 'Invalid investment details' });
    }

    // 1. Get Plan Details
    const { data: plan, error: planError } = await supabaseAdmin
      .from('wealth_plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError || !plan) return res.status(404).json({ error: 'Wealth plan not found' });
    if (investAmount !== Number(plan.invest_amount)) return res.status(400).json({ error: 'Amount does not match plan' });

    // 2. Check Balance
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    if (Number(wallet.balance) < investAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // 3. Deduct Balance
    const newBalance = Number(wallet.balance) - investAmount;
    await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('user_id', user.id);

    // 4. Save Investment (Using correct table name: wealth_investments)
    const { data: investment, error: invError } = await supabaseAdmin
      .from('wealth_investments')
      .insert({
        user_id: user.id,
        plan_id: plan.id,
        plan_name: plan.name,
        amount: investAmount,
        return_amount: Number(plan.return_amount),
        duration_days: Number(plan.duration_days),
        status: 'active'
      })
      .select()
      .single();

    if (invError) {
      // Rollback if save fails
      await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) }).eq('user_id', user.id);
      return res.status(500).json({ error: 'Failed to save investment: ' + invError.message });
    }

    // 5. Record Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_invest',
      amount: investAmount,
      status: 'approved',
      reference: `inv_${investment.id}`,
      description: `Invested in ${plan.name}`
    });

    return res.status(200).json({ success: true, message: 'Investment successful', newBalance });

  } catch (err) {
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

    // 1. Get the investment (Using correct table name)
    const { data: inv, error: invError } = await supabaseAdmin
      .from('wealth_investments')
      .select('*')
      .eq('id', investment_id)
      .eq('user_id', user.id)
      .single();

    if (invError || !inv) return res.status(404).json({ error: 'Investment not found' });
    if (inv.status !== 'active') return res.status(400).json({ error: 'Investment already claimed' });

    // 2. Check Maturity (Supports decimals like 0.00208333 for 3 mins)
    const startDate = new Date(inv.created_at);
    const maturityDate = new Date(startDate);
    const durationMs = inv.duration_days * 24 * 60 * 60 * 1000; 
    maturityDate.setTime(startDate.getTime() + durationMs);

    if (new Date() < maturityDate) {
      const remainingMins = Math.ceil((maturityDate - new Date()) / 60000);
      return res.status(400).json({ error: `Not matured yet. Wait ${remainingMins} more minutes.` });
    }

    // 3. Credit Wallet
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    const newBalance = Number(wallet.balance) + Number(inv.return_amount);
    await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('user_id', user.id);

    // 4. Mark as Completed
    await supabaseAdmin.from('wealth_investments').update({ 
      status: 'completed', 
      completed_at: new Date() 
    }).eq('id', investment_id);

    // 5. Record Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_claim',
      amount: inv.return_amount,
      status: 'approved',
      reference: `claim_${inv.id}`,
      description: `Claimed returns from ${inv.plan_name}`
    });

    return res.status(200).json({ success: true, message: 'Claimed successfully!', newBalance });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
