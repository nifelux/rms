/**
 * Notifications API — in-app notifications + Telegram bot
 * Actions (query param ?action=):
 *   list, markRead, send          — in-app notifications
 *   telegramWebhook               — Telegram bot webhook (see setup note below)
 *
 * SETUP NOTE: if telegram.js previously had its own webhook URL
 * registered with Telegram (via setWebhook), you must re-register it
 * to point here instead, e.g.:
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/notification?action=telegramWebhook
 * Telegram will keep POSTing to the old URL (now 404) until this is updated.
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';
import { approveDepositCore, rejectDepositCore, approveWithdrawalCore, rejectWithdrawalCore, createGiftCodeCore, generateRandomGiftCode } from './admin.js';
import { purgeOldWithdrawalProofsCore } from './finance.js';

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
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// In-app notifications (unchanged from notification.js)
// ============================================================

async function list(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
  return res.status(200).json(data);
}

async function markRead(req, res) {
  const user = await verifyUser(req);
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
    // Inline-keyboard button presses (Approve/Reject on deposits & withdrawals)
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
        case '/broadcast': return await handleBroadcast(chatId, text, res);
        case '/purgeproofs': return await handlePurgeProofs(chatId, res);
        case '/giftcode': return await handleGiftCode(chatId, text, res);
        case '/help': return await handleHelp(chatId, res);
        default:
          await sendToTelegram(chatId, 'Unknown command. Use /help');
          return res.status(200).end();
      }
    }
    return res.status(200).end();
  } catch (err) {
    // Previously a bare 500 with no body — meant a failing command (e.g.
    // /broadcast hitting a DB constraint) looked exactly like "nothing
    // happened" from the admin's side, with no way to tell why. Now the
    // error is reported straight back to whichever chat sent the command.
    console.error('Telegram webhook error:', err);
    const chatId = update?.message?.chat?.id?.toString() || update?.callback_query?.message?.chat?.id?.toString();
    if (chatId && ADMIN_CHAT_IDS.includes(chatId)) {
      await sendToTelegram(chatId, `⚠️ Command failed: ${err.message}`);
    }
    return res.status(200).end(); // 200 so Telegram doesn't endlessly retry
  }
}

async function sendToTelegram(chatId, text, replyMarkup) {
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
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
  });
}

// ------------------------------------------------------------
// Inline button handling: Approve/Reject on deposits & withdrawals
// callback_data format: "approve_deposit:<id>", "reject_withdrawal:<id>", etc.
// Reject buttons reject immediately with no reason attached — for a
// reason on record, use the admin panel instead.
// ------------------------------------------------------------
async function handleCallbackQuery(callbackQuery, res) {
  const chatId = callbackQuery.message.chat.id.toString();
  const messageId = callbackQuery.message.message_id;

  if (!ADMIN_CHAT_IDS.includes(chatId)) {
    await answerCallbackQuery(callbackQuery.id, 'Not authorized');
    return res.status(200).end();
  }

  const [rawAction, id] = (callbackQuery.data || '').split(':');
  const actions = {
    approve_deposit: () => approveDepositCore(id),
    reject_deposit: () => rejectDepositCore(id),
    approve_withdrawal: () => approveWithdrawalCore(id),
    reject_withdrawal: () => rejectWithdrawalCore(id)
  };

  const run = actions[rawAction];
  if (!run) {
    await answerCallbackQuery(callbackQuery.id, 'Unknown action');
    return res.status(200).end();
  }

  const result = await run();
  await answerCallbackQuery(callbackQuery.id, result.ok ? 'Done ✅' : `Failed: ${result.error}`);
  await editTelegramMessage(
    chatId,
    messageId,
    result.ok
      ? `${callbackQuery.message.text}\n\n✅ <b>${result.message}</b>`
      : `${callbackQuery.message.text}\n\n⚠️ <b>Failed:</b> ${result.error}`
  );
  return res.status(200).end();
}

async function handleStats(chatId, res) {
  const [users, deposits, withdrawals] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact' }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved')
  ]);
  const totalDep = deposits.data.reduce((s, d) => s + d.amount, 0);
  const totalWith = withdrawals.data.reduce((s, w) => s + w.amount, 0);
  const msg = `<b>📊 Platform Stats</b>\n👥 Users: ${users.count}\n💰 Approved Deposits: ₦${totalDep.toLocaleString()}\n💸 Approved Withdrawals: ₦${totalWith.toLocaleString()}`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

async function handleUsers(chatId, res) {
  const { data } = await supabaseAdmin.from('profiles').select('email, created_at').order('created_at', { ascending: false }).limit(10);
  const list = data.map(u => `• ${u.email} (${new Date(u.created_at).toLocaleDateString()})`).join('\n');
  await sendToTelegram(chatId, `<b>Recent Users:</b>\n${list || 'None'}`);
  res.status(200).end();
}

async function handlePending(chatId, res) {
  const [dep, wit] = await Promise.all([
    supabaseAdmin.from('deposits').select('amount, user_id').eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('amount, user_id').eq('status', 'pending')
  ]);
  const msg = `⏳ <b>Pending Actions</b>\nDeposits: ${dep.data.length} (₦${dep.data.reduce((s, d) => s + d.amount, 0).toLocaleString()})\nWithdrawals: ${wit.data.length} (₦${wit.data.reduce((s, w) => s + w.amount, 0).toLocaleString()})\n\nUse /deposits or /withdrawals to approve/reject each one.`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

// Sends ONE message per pending deposit, each with its own inline
// Approve/Reject buttons — simpler to act on than one big list.
async function handleDeposits(chatId, res) {
  const { data } = await supabaseAdmin.from('deposits').select('*').eq('status', 'pending').limit(5);
  if (!data || data.length === 0) {
    await sendToTelegram(chatId, '<b>Pending Deposits:</b>\nNone');
    return res.status(200).end();
  }
  for (const d of data) {
    await sendToTelegram(
      chatId,
      `💰 <b>Deposit</b>\nID: <code>${d.id.slice(0, 8)}</code>\nAmount: ₦${d.amount}\nUser: <code>${d.user_id.slice(0, 8)}</code>`,
      { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_deposit:${d.id}` },
        { text: '❌ Reject', callback_data: `reject_deposit:${d.id}` }
      ]] }
    );
  }
  res.status(200).end();
}

async function handleWithdrawals(chatId, res) {
  const { data } = await supabaseAdmin.from('withdrawals').select('*').eq('status', 'pending').limit(5);
  if (!data || data.length === 0) {
    await sendToTelegram(chatId, '<b>Pending Withdrawals:</b>\nNone');
    return res.status(200).end();
  }
  for (const w of data) {
    await sendToTelegram(
      chatId,
      `💸 <b>Withdrawal</b>\nID: <code>${w.id.slice(0, 8)}</code>\nAmount: ₦${w.amount}\nUser: <code>${w.user_id.slice(0, 8)}</code>`,
      { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve_withdrawal:${w.id}` },
        { text: '❌ Reject', callback_data: `reject_withdrawal:${w.id}` }
      ]] }
    );
  }
  res.status(200).end();
}

async function handleBroadcast(chatId, text, res) {
  // Split on whitespace and drop the command token itself, instead of
  // stripping a hardcoded literal '/broadcast' string — the old version
  // silently failed to strip anything if the command came through with
  // different casing (e.g. Telegram clients sometimes send "/Broadcast").
  const msgText = text.split(' ').slice(1).join(' ').trim();
  if (!msgText) {
    await sendToTelegram(chatId, 'Usage: /broadcast <message>');
    return res.status(200).end();
  }

  const { data: users, error } = await supabaseAdmin.from('profiles').select('id');
  if (error) {
    // Previously an error here (e.g. a notifications table constraint)
    // was swallowed by the outer catch as a bare 500 — the admin just
    // saw nothing happen. Now it's reported directly.
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

async function handlePurgeProofs(chatId, res) {
  const result = await purgeOldWithdrawalProofsCore();
  if (!result.ok) {
    await sendToTelegram(chatId, `⚠️ Purge failed: ${result.error}`);
  } else {
    await sendToTelegram(chatId, `🗑️ ${result.message} (${result.deletedCount} removed)`);
  }
  res.status(200).end();
}

async function handleGiftCode(chatId, text, res) {
  // /giftcode <amount> [max_uses] [custom_code]
  const parts = text.split(' ').slice(1);
  const amount = Number(parts[0]);
  const maxUses = parts[1] ? Number(parts[1]) : 1;
  const customCode = parts[2];

  if (!amount || amount <= 0) {
    await sendToTelegram(chatId, 'Usage: /giftcode &lt;amount&gt; [max_uses] [custom_code]\ne.g. /giftcode 5000  or  /giftcode 5000 10 WELCOME2026');
    return res.status(200).end();
  }

  const code = customCode || generateRandomGiftCode();
  const result = await createGiftCodeCore(code, amount, maxUses);

  if (!result.ok) {
    await sendToTelegram(chatId, `⚠️ Failed to create gift code: ${result.error}`);
  } else {
    await sendToTelegram(chatId, `🎁 <b>Gift Code Created</b>\nCode: <code>${result.record.code}</code>\nAmount: ₦${result.record.amount.toLocaleString()}\nMax uses: ${result.record.max_uses}`);
  }
  res.status(200).end();
}

async function handleHelp(chatId, res) {
  const msg = `<b>Admin Commands:</b>
/stats - Platform statistics
/users - Recent 10 users
/pending - Pending deposits/withdrawals summary
/deposits - Pending deposits (with Approve/Reject buttons)
/withdrawals - Pending withdrawals (with Approve/Reject buttons)
/broadcast &lt;msg&gt; - Send message to all users
/purgeproofs - Manually delete yesterday's-and-older withdrawal proof screenshots
/giftcode &lt;amount&gt; [max_uses] [code] - Create a gift code (auto-generates code if omitted)
/help - Show this help`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
  }
        
