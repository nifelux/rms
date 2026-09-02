/**
 * Notifications API — in-app notifications + Telegram bot
 * Actions (query param ?action=):
 *   list, markRead, send          — in-app notifications
 *   telegramWebhook               — Telegram bot webhook
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map(s => s.trim());

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'list': return list(req, res);
      case 'markRead': return markRead(req, res);
      case 'send': return sendNotification(req, res);
      case 'telegramWebhook': return telegramWebhook(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Notification API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// In-app notifications
// ============================================================
async function list(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { data } = await supabaseAdmin.from('notifications')
    .select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
  return res.status(200).json(data || []);
}

async function markRead(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { id } = req.body;
  if (id) {
    await supabaseAdmin.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
  } else {
    await supabaseAdmin.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
  }
  return res.status(200).json({ message: 'Updated' });
}

async function sendNotification(req, res) {
  await verifyAdmin(req);
  const { user_id, title, body } = req.body;
  if (!user_id || !title) return res.status(400).json({ error: 'Missing fields' });
  
  await supabaseAdmin.from('notifications').insert({ user_id, title, body });
  return res.status(200).json({ message: 'Notification sent' });
}

// ============================================================
// Telegram bot webhook + admin commands
// ============================================================
async function telegramWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'Telegram webhook endpoint' });
  }
  const update = req.body;

  try {
    if (update.callback_query) {
      return await handleCallbackQuery(update.callback_query, res);
    }

    if (update.message && update.message.text) {
      const chatId = update.message.chat.id.toString();
      if (!ADMIN_CHAT_IDS.includes(chatId)) {
        return res.status(200).end(); // ignore non-admin messages
      }
      const text = update.message.text.trim();
      const command = text.split(' ')[0].toLowerCase();

      switch (command) {
        case '/stats': return await handleStats(chatId, res);
        case '/users': return await handleUsers(chatId, res);
        case '/pending': return await handlePending(chatId, res);
        case '/deposits': return await handleDeposits(chatId, res);
        case '/withdrawals': return await handleWithdrawals(chatId, res);
        case '/wealthplans': return await handleWealthPlans(chatId, res);
        case '/rmstiers': return await handleRmsTiers(chatId, res);
        case '/maintenance': return await handleMaintenance(chatId, text, res);
        case '/setting': return await handleSetting(chatId, text, res);
        case '/tickets': return await handleTickets(chatId, res);
        case '/reply': return await handleTicketReply(chatId, text, res);
        case '/close': return await handleTicketClose(chatId, text, res);
        case '/broadcast': return await handleBroadcast(chatId, text, res);
        case '/giftcode': return await handleGiftCode(chatId, text, res);
        case '/help': return await handleHelp(chatId, res);
        default:
          await sendToTelegram(chatId, 'Unknown command. Use /help');
          return res.status(200).end();
      }
    }
    return res.status(200).end();
  } catch (err) {
    console.error('Telegram webhook error:', err);
    const chatId = update?.message?.chat?.id?.toString() || update?.callback_query?.message?.chat?.id?.toString();
    if (chatId && ADMIN_CHAT_IDS.includes(chatId)) {
      await sendToTelegram(chatId, `⚠️ Command failed: ${err.message}`);
    }
    return res.status(200).end();
  }
}

async function sendToTelegram(chatId, text, replyMarkup) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
}

async function editTelegramMessage(chatId, messageId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  });
}

// ------------------------------------------------------------
// Inline button handling: Approve/Reject on deposits & withdrawals
// ------------------------------------------------------------
async function handleCallbackQuery(callbackQuery, res) {
  const chatId = callbackQuery.message.chat.id.toString();
  const messageId = callbackQuery.message.message_id;

  if (!ADMIN_CHAT_IDS.includes(chatId)) {
    await answerCallbackQuery(callbackQuery.id, 'Not authorized');
    return res.status(200).end();
  }

  const [rawAction, id] = (callbackQuery.data || '').split(':');
  
  try {
    if (rawAction === 'approve_deposit') {
      await supabaseAdmin.from('deposits').update({ status: 'approved', updated_at: new Date() }).eq('id', id);
      const { data: dep } = await supabaseAdmin.from('deposits').select('*').eq('id', id).single();
      if (dep) {
        await supabaseAdmin.from('transactions').insert({
          user_id: dep.user_id, type: 'deposit', amount: dep.amount,
          status: 'approved', reference: `dep_${dep.id}`, description: 'Deposit approved via Telegram'
        });
      }
      await answerCallbackQuery(callbackQuery.id, 'Deposit Approved ✅');
      await editTelegramMessage(chatId, messageId, `${callbackQuery.message.text}\n\n✅ <b>Approved</b>`);
    } 
    else if (rawAction === 'reject_deposit') {
      await supabaseAdmin.from('deposits').update({ status: 'rejected', updated_at: new Date() }).eq('id', id);
      await answerCallbackQuery(callbackQuery.id, 'Deposit Rejected ❌');
      await editTelegramMessage(chatId, messageId, `${callbackQuery.message.text}\n\n❌ <b>Rejected</b>`);
    }
    else if (rawAction === 'approve_withdrawal') {
      await supabaseAdmin.from('withdrawals').update({ status: 'approved', updated_at: new Date() }).eq('id', id);
      await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${id}`);
      await answerCallbackQuery(callbackQuery.id, 'Withdrawal Approved ✅');
      await editTelegramMessage(chatId, messageId, `${callbackQuery.message.text}\n\n✅ <b>Approved</b>`);
    }
    else if (rawAction === 'reject_withdrawal') {
      await supabaseAdmin.from('withdrawals').update({ status: 'rejected', updated_at: new Date() }).eq('id', id);
      await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `wd_${id}`);
      await answerCallbackQuery(callbackQuery.id, 'Withdrawal Rejected ❌');
      await editTelegramMessage(chatId, messageId, `${callbackQuery.message.text}\n\n❌ <b>Rejected</b>`);
    }
    else {
      await answerCallbackQuery(callbackQuery.id, 'Unknown action');
    }
  } catch (err) {
    await answerCallbackQuery(callbackQuery.id, `Failed: ${err.message}`);
  }
  
  return res.status(200).end();
}

function tgEscape(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// --- Command Handlers ---

async function handleStats(chatId, res) {
  const [users, deposits, withdrawals] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact' }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved')
  ]);
  const totalDep = (deposits.data || []).reduce((s, d) => s + Number(d.amount), 0);
  const totalWith = (withdrawals.data || []).reduce((s, w) => s + Number(w.amount), 0);
  const msg = `<b>📊 Platform Stats</b>\n👥 Users: ${users.count || 0}\n💰 Approved Deposits: ₦${totalDep.toLocaleString()}\n💸 Approved Withdrawals: ₦${totalWith.toLocaleString()}`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

async function handleUsers(chatId, res) {
  const { data } = await supabaseAdmin.from('profiles').select('email, created_at').order('created_at', { ascending: false }).limit(10);
  const list = (data || []).map(u => `• ${tgEscape(u.email)} (${new Date(u.created_at).toLocaleDateString()})`).join('\n');
  await sendToTelegram(chatId, `<b>Recent Users:</b>\n${list || 'None'}`);
  res.status(200).end();
}

async function handlePending(chatId, res) {
  const [dep, wit] = await Promise.all([
    supabaseAdmin.from('deposits').select('amount').eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'pending')
  ]);
  const depData = dep.data || [];
  const witData = wit.data || [];
  const msg = `⏳ <b>Pending Actions</b>\nDeposits: ${depData.length} (₦${depData.reduce((s, d) => s + Number(d.amount), 0).toLocaleString()})\nWithdrawals: ${witData.length} (₦${witData.reduce((s, w) => s + Number(w.amount), 0).toLocaleString()})\n\nUse /deposits or /withdrawals to approve/reject.`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

async function handleDeposits(chatId, res) {
  const { data } = await supabaseAdmin.from('deposits').select('*, profiles(email, full_name)').eq('status', 'pending').limit(5);
  if (!data || data.length === 0) {
    await sendToTelegram(chatId, '<b>Pending Deposits:</b>\nNone');
    return res.status(200).end();
  }
  for (const d of data) {
    await sendToTelegram(
      chatId,
      `💰 <b>Deposit</b>\nID: <code>${d.id.slice(0, 8)}</code>\nAmount: ₦${Number(d.amount).toLocaleString()}\nUser: ${tgEscape(d.profiles?.full_name || d.user_id.slice(0, 8))}\nEmail: ${tgEscape(d.profiles?.email || 'Unavailable')}`,
      { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_deposit:${d.id}` },
        { text: '❌ Reject', callback_data: `reject_deposit:${d.id}` }
      ]] }
    );
  }
  res.status(200).end();
}

async function handleWithdrawals(chatId, res) {
  const { data } = await supabaseAdmin.from('withdrawals').select('*, profiles(email, full_name)').eq('status', 'pending').limit(5);
  if (!data || data.length === 0) {
    await sendToTelegram(chatId, '<b>Pending Withdrawals:</b>\nNone');
    return res.status(200).end();
  }
  for (const w of data) {
    const bank = w.bank_details || {};
    await sendToTelegram(
      chatId,
      `💸 <b>Withdrawal</b>\nID: <code>${w.id.slice(0, 8)}</code>\nAmount: ₦${Number(w.amount).toLocaleString()}\nUser: ${tgEscape(w.profiles?.full_name || w.user_id.slice(0, 8))}\nBank: ${tgEscape(bank.bank_name || 'N/A')} - ${tgEscape(bank.account_number || 'N/A')}`,
      { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_withdrawal:${w.id}` },
        { text: '❌ Reject', callback_data: `reject_withdrawal:${w.id}` }
      ]] }
    );
  }
  res.status(200).end();
}

async function handleWealthPlans(chatId, res) {
  const { data, error } = await supabaseAdmin.from('wealth_plans').select('id, name, invest_amount, return_amount, duration_days, is_active').order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  const msg = (data || []).map(p => `<b>${tgEscape(p.name)}</b> ${p.is_active ? '✅' : '🔒'}\nInvest: ₦${Number(p.invest_amount).toLocaleString()} → Return: ₦${Number(p.return_amount).toLocaleString()}\nDuration: ${p.duration_days} days`).join('\n\n') || 'No wealth plans.';
  await sendToTelegram(chatId, `<b>Wealth Plans</b>\n${msg}`);
  res.status(200).end();
}

async function handleRmsTiers(chatId, res) {
  const { data, error } = await supabaseAdmin.from('rms_tiers').select('*').order('upgrade_cost', { ascending: true });
  if (error) throw error;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const msg = (data || []).map(t => `<b>${tgEscape(t.tier)}</b>\nCost: ₦${Number(t.upgrade_cost).toLocaleString()}\nBoxes: ${t.daily_boxes}/day @ ₦${Number(t.box_earning).toLocaleString()}\nWithdrawal: ${days[t.withdrawal_day]}`).join('\n\n') || 'No tiers.';
  await sendToTelegram(chatId, `<b>RMS Tiers</b>\n${msg}`);
  res.status(200).end();
}

async function handleMaintenance(chatId, text, res) {
  const value = text.split(/\s+/)[1]?.toLowerCase();
  if (!['on', 'off'].includes(value)) {
    await sendToTelegram(chatId, 'Usage: /maintenance <on|off>');
    return res.status(200).end();
  }
  const { error } = await supabaseAdmin.from('settings').upsert({ key: 'maintenance_mode', value: value === 'on' ? 'true' : 'false', updated_at: new Date() });
  await sendToTelegram(chatId, error ? `⚠️ ${tgEscape(error.message)}` : `✅ Maintenance mode ${value === 'on' ? 'enabled' : 'disabled'}`);
  res.status(200).end();
}

async function handleSetting(chatId, text, res) {
  const first = text.indexOf(' '), second = text.indexOf(' ', first + 1);
  const key = first > 0 ? text.slice(first + 1, second > 0 ? second : undefined) : '';
  const raw = second > 0 ? text.slice(second + 1) : '';
  if (!key || !raw) {
    await sendToTelegram(chatId, 'Usage: /setting <key> <json>');
    return res.status(200).end();
  }
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  
  const { error } = await supabaseAdmin.from('settings').upsert({ key, value, updated_at: new Date() });
  await sendToTelegram(chatId, error ? `⚠️ ${tgEscape(error.message)}` : `✅ Setting saved: ${tgEscape(key)}`);
  res.status(200).end();
}

async function handleTickets(chatId, res) {
  const { data, error } = await supabaseAdmin.from('support_tickets').select('id, subject, status, created_at, profiles(email)').order('created_at', { ascending: false }).limit(10);
  if (error) throw error;
  const msg = (data || []).map(t => `<code>${t.id.slice(0, 8)}</code> · ${tgEscape(t.status)}\n${tgEscape(t.subject)} · ${tgEscape(t.profiles?.email || '')}`).join('\n\n') || 'None';
  await sendToTelegram(chatId, `<b>Support Tickets</b>\n${msg}`);
  res.status(200).end();
}

async function handleTicketReply(chatId, text, res) {
  const first = text.indexOf(' '), second = text.indexOf(' ', first + 1);
  const id = first > 0 ? text.slice(first + 1, second > 0 ? second : undefined) : '';
  const message = second > 0 ? text.slice(second + 1) : '';
  if (!id || !message) {
    await sendToTelegram(chatId, 'Usage: /reply <ticket_id> <message>');
    return res.status(200).end();
  }
  const { error } = await supabaseAdmin.from('ticket_replies').insert({ ticket_id: id, user_id: null, is_admin_reply: true, message });
  if (!error) await supabaseAdmin.from('support_tickets').update({ status: 'answered', updated_at: new Date() }).eq('id', id);
  await sendToTelegram(chatId, error ? `⚠️ ${tgEscape(error.message)}` : '✅ Reply sent');
  res.status(200).end();
}

async function handleTicketClose(chatId, text, res) {
  const id = text.split(/\s+/)[1];
  if (!id) {
    await sendToTelegram(chatId, 'Usage: /close <ticket_id>');
    return res.status(200).end();
  }
  const { error } = await supabaseAdmin.from('support_tickets').update({ status: 'closed', updated_at: new Date() }).eq('id', id);
  await sendToTelegram(chatId, error ? `⚠️ ${tgEscape(error.message)}` : '✅ Ticket closed');
  res.status(200).end();
}

async function handleBroadcast(chatId, text, res) {
  const msgText = text.split(' ').slice(1).join(' ').trim();
  if (!msgText) {
    await sendToTelegram(chatId, 'Usage: /broadcast <message>');
    return res.status(200).end();
  }

  const { data: users, error } = await supabaseAdmin.from('profiles').select('id');
  if (error) {
    await sendToTelegram(chatId, `⚠️ Broadcast failed while fetching users: ${error.message}`);
    return res.status(200).end();
  }

  const notifications = (users || []).map(u => ({ user_id: u.id, title: 'Admin Broadcast', body: msgText }));
  const { error: insertErr } = await supabaseAdmin.from('notifications').insert(notifications);
  if (insertErr) {
    await sendToTelegram(chatId, `⚠️ Broadcast failed: ${insertErr.message}`);
    return res.status(200).end();
  }

  await sendToTelegram(chatId, `✅ Broadcast sent to ${notifications.length} users.`);
  res.status(200).end();
}

async function handleGiftCode(chatId, text, res) {
  const parts = text.split(' ').slice(1);
  const amount = Number(parts[0]);
  const maxUses = parts[1] ? Number(parts[1]) : 1;
  const customCode = parts[2] || `GIFT${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  if (!amount || amount <= 0) {
    await sendToTelegram(chatId, 'Usage: /giftcode <amount> [max_uses] [custom_code]\ne.g. /giftcode 5000 or /giftcode 5000 10 WELCOME');
    return res.status(200).end();
  }

  const { data, error } = await supabaseAdmin.from('gift_codes').insert({
    code: customCode, amount, max_uses: maxUses, is_active: true
  }).select().single();

  if (error) {
    await sendToTelegram(chatId, `⚠️ Failed to create gift code: ${error.message}`);
  } else {
    await sendToTelegram(chatId, `🎁 <b>Gift Code Created</b>\nCode: <code>${data.code}</code>\nAmount: ₦${Number(data.amount).toLocaleString()}\nMax uses: ${data.max_uses}`);
  }
  res.status(200).end();
}

async function handleHelp(chatId, res) {
  const msg = `<b>Admin Commands:</b>
/stats, /users, /pending - Platform summaries
/deposits, /withdrawals - Review pending items with buttons
/wealthplans, /rmstiers - View active plans and tiers
/maintenance <on|off> - Toggle maintenance mode
/setting <key> <json> - Update settings
/tickets, /reply <id> <msg>, /close <id> - Manage support
/broadcast <msg> - Send message to all users
/giftcode <amount> [max_uses] [code] - Create a gift code
/help - Show this help`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}
