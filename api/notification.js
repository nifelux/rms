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
        case '/kyc': return await handleKyc(chatId, res);
        case '/products': return await handleProducts(chatId, res);
        case '/lockproduct': return await handleLockProduct(chatId, text, res);
        case '/createproduct': return await handleCreateProduct(chatId, text, res);
        case '/updateproduct': return await handleUpdateProduct(chatId, text, res);
        case '/deleteproduct': return await handleDeleteProduct(chatId, text, res);
        case '/runincome': return await handleRunIncome(chatId, res);
        case '/cron': return await handleCron(chatId, res);
        case '/health': return await handleHealth(chatId, res);
        case '/admins': return await handleAdmins(chatId, res);
        case '/promote': return await handleRoleChange(chatId, text, res, true);
        case '/demote': return await handleRoleChange(chatId, text, res, false);
        case '/maintenance': return await handleMaintenance(chatId, text, res);
        case '/setting': return await handleSetting(chatId, text, res);
        case '/tiers': return await handleTiers(chatId, res);
        case '/tier': return await handleTierUpdate(chatId, text, res);
        case '/vip': return await handleVip(chatId, text, res);
        case '/viplevels': return await handleVipLevels(chatId, res);
        case '/tickets': return await handleTickets(chatId, res);
        case '/reply': return await handleTicketReply(chatId, text, res);
        case '/close': return await handleTicketClose(chatId, text, res);
        case '/notifications': return await handleNotifications(chatId, res);
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
    reject_withdrawal: () => rejectWithdrawalCore(id),
    approve_kyc: () => updateKyc(id, 'approved'),
    reject_kyc: () => updateKyc(id, 'rejected')
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

function tgEscape(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function updateKyc(id, status) { const { data, error } = await supabaseAdmin.from('kyc_documents').update({ status }).eq('id', id).select().single(); return error ? { ok:false, error:error.message } : { ok:true, message:`KYC ${status}`, data }; }
async function handleKyc(chatId, res) { const { data, error } = await supabaseAdmin.from('kyc_documents').select('id,user_id,doc_type,status,profiles(email)').eq('status','pending').limit(10); if(error) throw error; if(!data?.length) await sendToTelegram(chatId,'<b>Pending KYC:</b> None'); else for(const d of data) await sendToTelegram(chatId,`🪪 <b>KYC Review</b>\nUser: ${tgEscape(d.profiles?.email || d.user_id)}\nType: ${tgEscape(d.doc_type || 'document')}`,{inline_keyboard:[[{text:'✅ Approve',callback_data:`approve_kyc:${d.id}`},{text:'❌ Reject',callback_data:`reject_kyc:${d.id}`}]]}); return res.status(200).end(); }
async function handleProducts(chatId, res) { const { data, error } = await supabaseAdmin.from('products').select('id,name,min_invest,max_invest,daily_roi_percent,duration_days,is_locked').order('created_at',{ascending:false}).limit(20); if(error) throw error; const msg=(data||[]).map(p=>`<b>${tgEscape(p.name)}</b> · ${p.is_locked?'🔒 locked':'✅ open'}\nID: <code>${p.id}</code>\nRange: ₦${Number(p.min_invest||0).toLocaleString()}–₦${Number(p.max_invest||0).toLocaleString()} · ROI ${p.daily_roi_percent||0}% · ${p.duration_days||0} days`).join('\n\n') || 'No products.'; await sendToTelegram(chatId,`<b>Products</b>\n${msg}`); return res.status(200).end(); }
async function handleLockProduct(chatId, text, res) { const [id, value] = text.split(/\s+/).slice(1); if(!id || !['on','off','lock','unlock'].includes((value||'').toLowerCase())) { await sendToTelegram(chatId,'Usage: /lockproduct <id> <on|off>'); return res.status(200).end(); } const is_locked=['on','lock'].includes(value.toLowerCase()); const {error}=await supabaseAdmin.from('products').update({is_locked}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ Product ${is_locked?'locked':'unlocked'}`); return res.status(200).end(); }
async function handleCreateProduct(chatId, text, res) { const parts=text.slice(text.indexOf(' ')+1).split('|').map(x=>x.trim()); if(parts.length<6){await sendToTelegram(chatId,'Usage: /createproduct name|description|minimum|max|roi_percent|duration_days|daily_income|max_purchases|category');return res.status(200).end();} const [name,description,min,max,roi,duration,daily,maxPurchases,category]=parts; const {data,error}=await supabaseAdmin.from('products').insert({name,description,min_invest:Number(min),max_invest:Number(max)||null,daily_roi_percent:Number(roi),duration_days:Number(duration),daily_income_amount:Number(daily)||null,max_purchases_per_user:Number(maxPurchases)||null,category:category||'investment'}).select().single(); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ Product created: <b>${tgEscape(data.name)}</b>`); return res.status(200).end(); }
async function handleUpdateProduct(chatId, text, res) { const parts=text.slice(text.indexOf(' ')+1).split('|').map(x=>x.trim()); if(parts.length<7){await sendToTelegram(chatId,'Usage: /updateproduct id|name|description|min|max|roi_percent|duration_days|daily_income|max_purchases|category');return res.status(200).end();} const [id,name,description,min,max,roi,duration,daily,maxPurchases,category]=parts; const {error}=await supabaseAdmin.from('products').update({name,description,min_invest:Number(min),max_invest:Number(max)||null,daily_roi_percent:Number(roi),duration_days:Number(duration),daily_income_amount:Number(daily)||null,max_purchases_per_user:Number(maxPurchases)||null,category:category||'investment'}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:'✅ Product updated'); return res.status(200).end(); }
async function handleDeleteProduct(chatId, text, res) { const id=text.split(/\s+/)[1]; if(!id){await sendToTelegram(chatId,'Usage: /deleteproduct <id>');return res.status(200).end();} const {error}=await supabaseAdmin.from('products').delete().eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:'✅ Product deleted'); return res.status(200).end(); }
async function handleRunIncome(chatId, res) { const today=new Date().toISOString().slice(0,10); const {data:due,error}=await supabaseAdmin.from('investments').select('*').eq('status','active').or(`last_income_date.is.null,last_income_date.lt.${today}`); if(error) throw error; let paid=0,completed=0; for(const inv of due||[]){const days=Number(inv.days_elapsed)+1;const total=Number(inv.total_income)+Number(inv.daily_income);const done=days>=Number(inv.duration_days);const tx=await supabaseAdmin.from('transactions').insert({user_id:inv.user_id,type:'earning',amount:Number(inv.daily_income),status:'approved',reference:`inv_income_${inv.id}_day${days}`});if(tx.error&&!tx.error.message.includes('duplicate'))continue;await supabaseAdmin.from('investments').update({days_elapsed:days,total_income:total,last_income_date:today,status:done?'completed':'active'}).eq('id',inv.id);paid++;if(done)completed++;} await supabaseAdmin.from('cron_logs').insert({job_name:'daily_income',status:'success',details:{paidCount:paid,completedCount:completed,triggeredBy:'telegram'}}); await sendToTelegram(chatId,`✅ Daily income processed\nPaid: ${paid}\nCompleted: ${completed}`); return res.status(200).end(); }
async function handleCron(chatId, res) { const {data,error}=await supabaseAdmin.from('cron_logs').select('*').order('created_at',{ascending:false}).limit(5); if(error) throw error; await sendToTelegram(chatId,`<b>Recent cron runs</b>\n${(data||[]).map(x=>`${tgEscape(x.job_name)} · ${tgEscape(x.status)} · ${new Date(x.created_at).toLocaleString()}`).join('\n')||'None'}`); return res.status(200).end(); }
async function handleHealth(chatId, res) { const {data,error}=await supabaseAdmin.from('cron_logs').select('*').order('created_at',{ascending:false}).limit(1); if(error) throw error; await sendToTelegram(chatId,`<b>System health</b>\nDatabase: ✅\nLast cron: ${data?.[0]?`${tgEscape(data[0].job_name)} · ${tgEscape(data[0].status)}`:'None'}`); return res.status(200).end(); }
async function handleAdmins(chatId, res) { const {data,error}=await supabaseAdmin.from('profiles').select('id,email,full_name').eq('is_admin',true); if(error) throw error; await sendToTelegram(chatId,`<b>Admins</b>\n${(data||[]).map(a=>`${tgEscape(a.full_name||'N/A')} · ${tgEscape(a.email)}\n<code>${a.id}</code>`).join('\n\n')||'None'}`); return res.status(200).end(); }
async function handleRoleChange(chatId, text, res, promote) { const id=text.split(/\s+/)[1]; if(!id){await sendToTelegram(chatId,`Usage: /${promote?'promote':'demote'} <user_id>`);return res.status(200).end();} const {error}=await supabaseAdmin.from('profiles').update({is_admin:promote}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ ${promote?'Promoted to':'Removed from'} admin: <code>${id}</code>`); return res.status(200).end(); }
async function handleMaintenance(chatId, text, res) { const value=text.split(/\s+/)[1]?.toLowerCase(); if(!['on','off'].includes(value)){await sendToTelegram(chatId,'Usage: /maintenance <on|off>');return res.status(200).end();} const {error}=await supabaseAdmin.from('settings').upsert({key:'maintenance_mode',value:value==='on'?'true':'false',updated_at:new Date()}); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ Maintenance mode ${value==='on'?'enabled':'disabled'}`); return res.status(200).end(); }
async function handleSetting(chatId, text, res) { const first=text.indexOf(' '), second=text.indexOf(' ',first+1); const key=first>0?text.slice(first+1,second>0?second:undefined):''; const raw=second>0?text.slice(second+1):''; if(!key||!raw){await sendToTelegram(chatId,'Usage: /setting <key> <json>');return res.status(200).end();} let value; try{value=JSON.parse(raw);}catch{value=raw;} const {error}=await supabaseAdmin.from('settings').upsert({key,value,updated_at:new Date()}); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ Setting saved: ${tgEscape(key)}`); return res.status(200).end(); }
async function handleTiers(chatId, res) { const {data,error}=await supabaseAdmin.from('task_tiers').select('*').order('sort_order'); if(error) throw error; await sendToTelegram(chatId,`<b>Task tiers</b>\n${(data||[]).map(t=>`${tgEscape(t.name)} · ID <code>${t.id}</code>\nPrice ₦${t.price} · ${t.tasks_per_day}/day · ₦${t.pay_per_task}/task`).join('\n\n')||'None'}`); return res.status(200).end(); }
async function handleTierUpdate(chatId, text, res) { const parts=text.slice(text.indexOf(' ')+1).split('|').map(x=>x.trim()); if(parts.length!==4){await sendToTelegram(chatId,'Usage: /tier <id>|<price>|<tasks_per_day>|<pay_per_task>');return res.status(200).end();} const [id,price,tasks,pay]=parts; const {error}=await supabaseAdmin.from('task_tiers').update({price:Number(price),tasks_per_day:Number(tasks),pay_per_task:Number(pay)}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ Tier updated: <code>${id}</code>`); return res.status(200).end(); }
async function handleVip(chatId, text, res) { const parts=text.slice(text.indexOf(' ')+1).split('|').map(x=>x.trim()); if(parts.length<5){await sendToTelegram(chatId,'Usage: /vip <level>|<min_deposit>|<min_investments>|<min_referrals>|<daily_bonus_percent>');return res.status(200).end();} const [level,minDeposit,minInvestments,minReferrals,bonus]=parts; const {data,error}=await supabaseAdmin.from('vip_levels').insert({level,min_deposit:Number(minDeposit)||0,min_investments:Number(minInvestments)||0,min_referrals:Number(minReferrals)||0,daily_bonus_percent:Number(bonus)||0}).select().single(); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:`✅ VIP level created: ${tgEscape(data.level)}`); return res.status(200).end(); }
async function handleVipLevels(chatId, res) { const {data,error}=await supabaseAdmin.from('vip_levels').select('*').order('level'); if(error) throw error; await sendToTelegram(chatId,`<b>VIP levels</b>\n${(data||[]).map(v=>`${tgEscape(v.level)} · Deposit ₦${v.min_deposit||0} · Investments ₦${v.min_investments||0} · Referrals ${v.min_referrals||0} · Bonus ${v.daily_bonus_percent||0}%`).join('\n')||'None'}`); return res.status(200).end(); }
async function handleTickets(chatId, res) { const {data,error}=await supabaseAdmin.from('support_tickets').select('id,subject,status,created_at,profiles(email)').order('created_at',{ascending:false}).limit(10); if(error) throw error; await sendToTelegram(chatId,`<b>Support tickets</b>\n${(data||[]).map(t=>`<code>${t.id}</code> · ${tgEscape(t.status)}\n${tgEscape(t.subject)} · ${tgEscape(t.profiles?.email||'')}`).join('\n\n')||'None'}`); return res.status(200).end(); }
async function handleTicketReply(chatId, text, res) { const first=text.indexOf(' '), second=text.indexOf(' ',first+1); const id=first>0?text.slice(first+1,second>0?second:undefined):''; const message=second>0?text.slice(second+1):''; if(!id||!message){await sendToTelegram(chatId,'Usage: /reply <ticket_id> <message>');return res.status(200).end();} const {error}=await supabaseAdmin.from('ticket_replies').insert({ticket_id:id,user_id:null,is_admin_reply:true,message}); if(!error) await supabaseAdmin.from('support_tickets').update({status:'answered',updated_at:new Date()}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:'✅ Reply sent'); return res.status(200).end(); }
async function handleTicketClose(chatId, text, res) { const id=text.split(/\s+/)[1]; if(!id){await sendToTelegram(chatId,'Usage: /close <ticket_id>');return res.status(200).end();} const {error}=await supabaseAdmin.from('support_tickets').update({status:'closed',updated_at:new Date()}).eq('id',id); await sendToTelegram(chatId,error?`⚠️ ${tgEscape(error.message)}`:'✅ Ticket closed'); return res.status(200).end(); }
async function handleNotifications(chatId, res) { const {data,error}=await supabaseAdmin.from('notifications').select('title,body,created_at,profiles(email)').order('created_at',{ascending:false}).limit(10); if(error) throw error; await sendToTelegram(chatId,`<b>Recent notifications</b>\n${(data||[]).map(n=>`${tgEscape(n.title)} · ${tgEscape(n.profiles?.email||'All users')}\n${tgEscape(n.body||'')}`).join('\n\n')||'None'}`); return res.status(200).end(); }

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
  const { data } = await supabaseAdmin.from('deposits').select('*, profiles(email, full_name)').eq('status', 'pending').limit(5);
  if (!data || data.length === 0) {
    await sendToTelegram(chatId, '<b>Pending Deposits:</b>\nNone');
    return res.status(200).end();
  }
  for (const d of data) {
    await sendToTelegram(
      chatId,
      `💰 <b>Deposit</b>\nID: <code>${d.id.slice(0, 8)}</code>\nAmount: ₦${d.amount}\nUser: ${tgEscape(d.profiles?.full_name || d.user_id.slice(0, 8))}\nEmail: ${tgEscape(d.profiles?.email || 'Unavailable')}`,
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
    await sendToTelegram(
      chatId,
      `💸 <b>Withdrawal</b>\nID: <code>${w.id.slice(0, 8)}</code>\nAmount: ₦${w.amount}\nUser: ${tgEscape(w.profiles?.full_name || w.user_id.slice(0, 8))}\nEmail: ${tgEscape(w.profiles?.email || 'Unavailable')}`,
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
/stats, /users, /pending - Platform summaries
/deposits, /withdrawals, /kyc - Review pending items with buttons
/products - List products
/lockproduct &lt;id&gt; &lt;on|off&gt; - Lock or unlock a product
/createproduct name|description|min|max|roi|days|daily|max_purchases|category
/updateproduct id|name|description|min|max|roi|days|daily|max_purchases|category
/deleteproduct &lt;id&gt; - Delete a product
/runincome, /cron, /health - Income job and system controls
/admins, /promote &lt;id&gt;, /demote &lt;id&gt; - Manage admin access
/maintenance &lt;on|off&gt; - Toggle maintenance mode
/setting &lt;key&gt; &lt;json&gt; - Update settings and website content
/tiers, /tier id|price|tasks_per_day|pay - Manage task tiers
/vip level|min_deposit|min_investments|min_referrals|bonus - Create VIP level
/viplevels - List VIP levels
/tickets, /reply &lt;ticket_id&gt; &lt;message&gt;, /close &lt;ticket_id&gt; - Manage support
/notifications - Recent in-app notifications
/broadcast &lt;msg&gt; - Send message to all users
/purgeproofs - Delete old withdrawal proof screenshots
/giftcode &lt;amount&gt; [max_uses] [code] - Create a gift code
/help - Show this help`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
  }
        
