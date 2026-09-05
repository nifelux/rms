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
      case 'claim': return await claimInvestment(req, res); // NEW ACTION
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ... (Keep your existing 'invest' function here) ...

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  console.log('Wealth API called with action:', action);
  
  try {
    switch (action) {
      case 'invest': return await invest(req, res);
      default: return res.status(400).json({ error: 'Invalid action: ' + action });
    }
  } catch (err) {
    console.error('Wealth API Error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

async function invest(req, res) {
  try {
    console.log('Invest request received');
    
    // 1. Verify User from Token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.error('No auth header');
      return res.status(401).json({ error: 'No authorization header' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    
    if (userError || !user) {
      console.error('User verification failed:', userError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    console.log('User verified:', user.email);

    const { plan_id, amount } = req.body;
    const investAmount = Number(amount);

    if (!plan_id || !investAmount || investAmount <= 0) {
      return res.status(400).json({ error: 'Invalid investment details' });
    }

    // 2. Get Plan Details
    const { data: plan, error: planError } = await supabaseAdmin
      .from('wealth_plans')
      .select('*')
      .eq('id', plan_id)
      .single();

    if (planError || !plan) {
      console.error('Plan not found:', planError);
      return res.status(404).json({ error: 'Wealth plan not found' });
    }

    console.log('Plan found:', plan.name);

    // 3. Check User Balance
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (walletError || !wallet) {
      console.error('Wallet error:', walletError);
      return res.status(500).json({ error: 'Could not load wallet' });
    }

    const currentBalance = Number(wallet.balance);
    if (currentBalance < investAmount) {
      return res.status(400).json({ error: `Insufficient balance. You have ₦${currentBalance.toLocaleString()}, need ₦${investAmount.toLocaleString()}` });
    }

    console.log('Balance check passed. Current:', currentBalance, 'Investing:', investAmount);

    // 4. Deduct Balance
    const newBalance = currentBalance - investAmount;
    const { error: updateWalletError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date() })
      .eq('user_id', user.id);

    if (updateWalletError) {
      console.error('Wallet update failed:', updateWalletError);
      return res.status(500).json({ error: 'Failed to update wallet' });
    }

    console.log('Wallet updated. New balance:', newBalance);

    // 5. Save the Investment
    const { data: investment, error: invError } = await supabaseAdmin
      .from('investments')
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
      console.error('Investment save failed:', invError);
      // Rollback wallet
      await supabaseAdmin.from('wallets').update({ balance: currentBalance }).eq('user_id', user.id);
      return res.status(500).json({ error: 'Failed to save investment: ' + invError.message });
    }

    console.log('Investment saved:', investment.id);

    // 6. Record Transaction
    const { error: txnError } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'wealth_invest',
      amount: investAmount,
      status: 'approved',
      reference: `inv_${investment.id}`,
      description: `Invested in ${plan.name}`
    });

    if (txnError) {
      console.error('Transaction log failed:', txnError);
      // Don't fail the request, just log it
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Investment successful',
      investment: investment,
      newBalance: newBalance
    });

  } catch (err) {
    console.error('invest error:', err);
    return res.status(500).json({ error: err.message });
  }
  }
// NEW: Claim Investment Function
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
      .from('investments')
      .select('*')
      .eq('id', investment_id)
      .eq('user_id', user.id)
      .single();

    if (invError || !inv) return res.status(404).json({ error: 'Investment not found' });
    if (inv.status !== 'active') return res.status(400).json({ error: 'Investment already claimed or cancelled' });

    // 2. Check Maturity Date
    const startDate = new Date(inv.created_at);
    const maturityDate = new Date(startDate);
    maturityDate.setDate(startDate.getDate() + inv.duration_days);

    if (new Date() < maturityDate) {
      return res.status(400).json({ error: `Investment not matured yet. Matures on ${maturityDate.toLocaleDateString()}` });
    }

    // 3. Credit the Wallet with the Return Amount
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
    const newBalance = Number(wallet.balance) + Number(inv.return_amount);

    await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('user_id', user.id);

    // 4. Update Investment Status to 'completed'
    await supabaseAdmin.from('investments').update({ 
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
