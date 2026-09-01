import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  try {
    switch (action) {
      case 'getPlans': return await getPlans(req, res);
      case 'invest': return await invest(req, res);
      case 'claim': return await claim(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getPlans(req, res) {
  const { data: plans } = await supabaseAdmin.from('wealth_plans').select('*').eq('is_active', true);
  return res.status(200).json({ plans: plans || [] });
}

async function invest(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { plan_id } = req.body;
  const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level').eq('id', user.id).single();
  if (profile.vip_level === 'newbie') return res.status(400).json({ error: 'Only VIP members can invest in the Wealth Center.' });

  const { data: plan } = await supabaseAdmin.from('wealth_plans').select('*').eq('id', plan_id).single();
  if (!plan) return res.status(400).json({ error: 'Invalid plan.' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (wallet.balance < plan.invest_amount) return res.status(400).json({ error: 'Insufficient balance.' });

  const maturityDate = new Date();
  maturityDate.setDate(maturityDate.getDate() + plan.duration_days);

  // 1. Create Investment Record
  await supabaseAdmin.from('wealth_investments').insert({
    user_id: user.id, plan_id: plan.id, invest_amount: plan.invest_amount,
    return_amount: plan.return_amount, maturity_date: maturityDate.toISOString(), status: 'active'
  });

  // 2. Deduct Balance
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'wealth_invest', amount: plan.invest_amount,
    status: 'approved', reference: `wealth_${Date.now()}`, description: `Invested in ${plan.name}`
  });

  return res.status(200).json({ success: true, message: 'Investment successful!' });
}

async function claim(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { investment_id } = req.body;
  const { data: investment } = await supabaseAdmin.from('wealth_investments').select('*').eq('id', investment_id).single();

  if (!investment || investment.user_id !== user.id) return res.status(400).json({ error: 'Investment not found.' });
  if (investment.status !== 'matured') return res.status(400).json({ error: 'Investment is not matured yet.' });

  // 1. Credit Wallet
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'wealth_claim', amount: investment.return_amount,
    status: 'approved', reference: `claim_${Date.now()}`, description: `Claimed ${investment.plan_id}`
  });

  // 2. Mark as Claimed
  await supabaseAdmin.from('wealth_investments').update({ status: 'claimed' }).eq('id', investment_id);

  return res.status(200).json({ success: true, amount: investment.return_amount });
}
