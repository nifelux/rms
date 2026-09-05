import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'invest': return await invest(req, res);
      case 'getPlans': return await getPlans(req, res); // Optional: if you move plan fetching here
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Wealth API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function invest(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

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

    if (planError || !plan) {
      return res.status(404).json({ error: 'Wealth plan not found' });
    }

    // Ensure the amount matches the plan (security check)
    if (investAmount !== Number(plan.invest_amount)) {
      return res.status(400).json({ error: 'Investment amount does not match plan' });
    }

    // 2. Check User Balance
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (walletError || !wallet) {
      return res.status(500).json({ error: 'Could not load wallet' });
    }

    if (Number(wallet.balance) < investAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // 3. Deduct Balance
    const newBalance = Number(wallet.balance) - investAmount;
    const { error: updateWalletError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date() })
      .eq('user_id', user.id);

    if (updateWalletError) {
      return res.status(500).json({ error: 'Failed to update wallet' });
    }

    // 4. Save the Investment
    const { data: investment, error: invError } = await supabaseAdmin
      .from('investments')
      .insert({
        user_id: user.id,
        plan_id: plan.id,
        plan_name: plan.name,
        amount: investAmount,
        return_amount: plan.return_amount,
        duration_days: plan.duration_days,
        status: 'active'
      })
      .select()
      .single();

    if (invError) {
      // Rollback wallet if investment fails (optional but recommended)
      await supabaseAdmin.from('wallets').update({ balance: Number(wallet.balance) }).eq('user_id', user.id);
      return res.status(500).json({ error: 'Failed to save investment' });
    }

    // 5. Record the Transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_invest',
      amount: investAmount,
      status: 'approved',
      reference: `inv_${investment.id}`,
      description: `Invested in ${plan.name}`
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Investment successful',
      investment: investment
    });

  } catch (err) {
    console.error('invest error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function getPlans(req, res) {
  const { data: plans } = await supabaseAdmin.from('wealth_plans').select('*').eq('is_active', true);
  return res.status(200).json({ plans: plans || [] });
}
