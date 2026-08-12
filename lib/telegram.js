/**
 * Telegram Notification Helper
 * Sends messages to configured admin chat IDs using Bot API.
 */
import supabaseAdmin from './supabase.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

export async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || ADMIN_CHAT_IDS.length === 0) return;

  const results = [];
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
      const data = await res.json();
      results.push({ chatId, ok: data.ok, error: data.description });
    } catch (err) {
      results.push({ chatId, ok: false, error: err.message });
    }
  }
  // Log to DB
  if (results.length > 0) {
    await supabaseAdmin.from('telegram_logs').insert(results.map(r => ({
      event_type: 'notification',
      chat_id: r.chatId,
      message: message.substring(0, 200),
      success: r.ok,
      error: r.error
    })));
  }
  return results;
}
