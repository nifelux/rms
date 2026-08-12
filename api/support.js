/**
 * Support Tickets API
 * Actions: createTicket, listTickets, ticketDetail, addReply, closeTicket, (admin: listAll, adminReply)
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'create': return createTicket(req, res);
      case 'list': return listTickets(req, res);
      case 'detail': return ticketDetail(req, res);
      case 'reply': return addReply(req, res);
      case 'close': return closeTicket(req, res);
      case 'listAll': return listAllTickets(req, res); // admin
      case 'adminReply': return adminReply(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function createTicket(req, res) {
  const user = await verifyUser(req);
  const { subject, message } = req.body;
  const { data, error } = await supabaseAdmin.from('support_tickets').insert({
    user_id: user.id, subject, message
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await sendTelegramMessage(`🎫 New ticket: ${subject} from ${user.email}`);
  return res.status(200).json(data);
}

async function listTickets(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin.from('support_tickets')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function ticketDetail(req, res) {
  const user = await verifyUser(req);
  const { id } = req.query;
  const { data: ticket } = await supabaseAdmin.from('support_tickets').select('*').eq('id', id).eq('user_id', user.id).single();
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { data: replies } = await supabaseAdmin.from('ticket_replies').select('*').eq('ticket_id', id).order('created_at', { ascending: true });
  return res.status(200).json({ ticket, replies });
}

async function addReply(req, res) {
  const user = await verifyUser(req);
  const { ticket_id, message } = req.body;
  const { data: ticket } = await supabaseAdmin.from('support_tickets').select('*').eq('id', ticket_id).eq('user_id', user.id).single();
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  await supabaseAdmin.from('ticket_replies').insert({
    ticket_id, user_id: user.id, is_admin_reply: false, message
  });
  await supabaseAdmin.from('support_tickets').update({ status: 'open', updated_at: new Date() }).eq('id', ticket_id);
  return res.status(200).json({ message: 'Reply added' });
}

async function closeTicket(req, res) {
  const user = await verifyUser(req);
  const { ticket_id } = req.body;
  await supabaseAdmin.from('support_tickets').update({ status: 'closed', updated_at: new Date() }).eq('id', ticket_id).eq('user_id', user.id);
  return res.status(200).json({ message: 'Ticket closed' });
}

async function listAllTickets(req, res) {
  await verifyAdmin(req);
  const { status } = req.query;
  let query = supabaseAdmin.from('support_tickets').select('*, profiles(email)');
  if (status) query = query.eq('status', status);
  const { data } = await query.order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function adminReply(req, res) {
  const admin = await verifyAdmin(req);
  const { ticket_id, message } = req.body;
  await supabaseAdmin.from('ticket_replies').insert({
    ticket_id, user_id: null, is_admin_reply: true, message
  });
  await supabaseAdmin.from('support_tickets').update({ status: 'answered', updated_at: new Date() }).eq('id', ticket_id);
  // Notify user (insert notification)
  const { data: ticket } = await supabaseAdmin.from('support_tickets').select('user_id').eq('id', ticket_id).single();
  if (ticket) {
    await supabaseAdmin.from('notifications').insert({
      user_id: ticket.user_id,
      title: 'Support ticket answered',
      body: message.substring(0, 100)
    });
  }
  return res.status(200).json({ message: 'Reply sent' });
    }
