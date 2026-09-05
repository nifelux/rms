import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
