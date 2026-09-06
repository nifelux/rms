import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      case 'getWheelConfig': return await getWheelConfig(req, res);
      case 'spinWheel': return await spinWheel(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Wheel API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Get wheel configuration and user's spin count
async function getWheelConfig(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Get user's profile with team stats
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('wheel_spins, vip_level')
      .eq('id', user.id)
      .single();

    // Get wheel configuration from database
    let { data: wheelConfigs } = await supabaseAdmin
      .from('wheel_configs')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    // If no configs in DB, use defaults
    if (!wheelConfigs || wheelConfigs.length === 0) {
      wheelConfigs = [
        { id: 1, prize_amount: 300, weight: 30, color: '#FF6B6B' },
        { id: 2, prize_amount: 500, weight: 25, color: '#4ECDC4' },
        { id: 3, prize_amount: 1000, weight: 20, color: '#45B7D1' },
        { id: 4, prize_amount: 2000, weight: 15, color: '#FFA07A' },
        { id: 5, prize_amount: 3500, weight: 10, color: '#98D8C8' },
        { id: 6, prize_amount: 5000, weight: 7, color: '#F7DC6F' },
        { id: 7, prize_amount: 8000, weight: 4, color: '#BB8FCE' },
        { id: 8, prize_amount: 15000, weight: 2, color: '#FFD700' }
      ];
    }

    return res.status(200).json({
      wheel_spins: profile?.wheel_spins || 0,
      configs: wheelConfigs
    });

  } catch (err) {
    console.error('Get wheel config error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Spin the wheel and determine prize
async function spinWheel(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Get user's profile
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('wheel_spins, vip_level')
      .eq('id', user.id)
      .single();

    if (!profile || profile.wheel_spins < 1) {
      return res.status(400).json({ error: 'No spins available. Invite friends to get more spins!' });
    }

    // Calculate team quality score
    const teamQuality = await calculateTeamQuality(user.id);
    
    // Get wheel configurations
    let { data: wheelConfigs } = await supabaseAdmin
      .from('wheel_configs')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    // Use defaults if no configs
    if (!wheelConfigs || wheelConfigs.length === 0) {
      wheelConfigs = [
        { id: 1, prize_amount: 300, weight: 30, color: '#FF6B6B' },
        { id: 2, prize_amount: 500, weight: 25, color: '#4ECDC4' },
        { id: 3, prize_amount: 1000, weight: 20, color: '#45B7D1' },
        { id: 4, prize_amount: 2000, weight: 15, color: '#FFA07A' },
        { id: 5, prize_amount: 3500, weight: 10, color: '#98D8C8' },
        { id: 6, prize_amount: 5000, weight: 7, color: '#F7DC6F' },
        { id: 7, prize_amount: 8000, weight: 4, color: '#BB8FCE' },
        { id: 8, prize_amount: 15000, weight: 2, color: '#FFD700' }
      ];
    }

    // Adjust weights based on team quality
    const adjustedConfigs = adjustWeightsForTeamQuality(wheelConfigs, teamQuality);

    // Determine winning segment
    const winningSegment = determineWinner(adjustedConfigs);

    // Decrement spin count
    await supabaseAdmin
      .from('profiles')
      .update({ 
        wheel_spins: profile.wheel_spins - 1,
        updated_at: new Date()
      })
      .eq('id', user.id);

    // Credit wallet
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    const newBalance = (wallet?.balance || 0) + winningSegment.prize_amount;
    
    await supabaseAdmin
      .from('wallets')
      .upsert({
        user_id: user.id,
        balance: newBalance,
        updated_at: new Date()
      });

    // Record transaction
    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: user.id,
        type: 'wheel_win',
        amount: winningSegment.prize_amount,
        status: 'approved',
        reference: `wheel_${Date.now()}`,
        description: `Lucky Wheel Win - Team Score: ${teamQuality}`
      });

    return res.status(200).json({
      success: true,
      prize: winningSegment.prize_amount,
      segment_id: winningSegment.id,
      new_balance: newBalance,
      spins_remaining: profile.wheel_spins - 1,
      team_quality: teamQuality
    });

  } catch (err) {
    console.error('Spin wheel error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Calculate team quality score (0-100)
async function calculateTeamQuality(userId) {
  // Get direct referrals
  const { data: referrals } = await supabaseAdmin
    .from('profiles')
    .select('vip_level')
    .eq('referred_by', userId);

  if (!referrals || referrals.length === 0) {
    return 0;
  }

  let score = 0;
  const tierPoints = {
    'M0': 1,
    'M1': 5,
    'M2': 10,
    'M3': 20,
    'M4': 35,
    'M5': 50,
    'M6': 75,
    'M7': 100
  };

  // Calculate score based on referrals' VIP levels
  referrals.forEach(ref => {
    score += tierPoints[ref.vip_level] || 0;
  });

  // Normalize to 0-100 scale (max score would be if all 10 referrals are M7)
  const maxPossibleScore = referrals.length * 100;
  const normalizedScore = Math.min(100, Math.round((score / maxPossibleScore) * 100));

  return normalizedScore;
}

// Adjust prize weights based on team quality
function adjustWeightsForTeamQuality(configs, teamQuality) {
  // Team quality affects probability of high-value prizes
  // Higher team quality = better chance at high prizes
  
  return configs.map(config => {
    let adjustedWeight = config.weight;
    const prizeAmount = config.prize_amount;

    if (teamQuality >= 80) {
      // Excellent team: Boost high prizes significantly
      if (prizeAmount >= 8000) adjustedWeight *= 3;
      else if (prizeAmount >= 3500) adjustedWeight *= 2;
      else if (prizeAmount <= 500) adjustedWeight *= 0.5;
    } else if (teamQuality >= 60) {
      // Good team: Moderate boost to high prizes
      if (prizeAmount >= 8000) adjustedWeight *= 2;
      else if (prizeAmount >= 3500) adjustedWeight *= 1.5;
      else if (prizeAmount <= 500) adjustedWeight *= 0.7;
    } else if (teamQuality >= 40) {
      // Average team: Slight boost
      if (prizeAmount >= 5000) adjustedWeight *= 1.5;
      else if (prizeAmount <= 300) adjustedWeight *= 0.8;
    } else if (teamQuality === 0) {
      // No team: Heavily weighted toward low prizes
      if (prizeAmount >= 5000) adjustedWeight *= 0.3;
      else if (prizeAmount >= 2000) adjustedWeight *= 0.5;
      else if (prizeAmount <= 500) adjustedWeight *= 1.5;
    }

    return {
      ...config,
      adjusted_weight: adjustedWeight
    };
  });
}

// Determine winner based on weighted probabilities
function determineWinner(configs) {
  const totalWeight = configs.reduce((sum, config) => sum + config.adjusted_weight, 0);
  let random = Math.random() * totalWeight;

  for (const config of configs) {
    random -= config.adjusted_weight;
    if (random <= 0) {
      return config;
    }
  }

  // Fallback to last segment
  return configs[configs.length - 1];
}
