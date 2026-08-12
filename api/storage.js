/**
 * Storage Upload API (Server-side for security)
 * Action: upload
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import formidable from 'formidable'; // Vercel doesn't support formidable well; we'll use raw body parsing
// For simplicity, we'll accept base64 image data in JSON and upload.
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  const { action } = req.query;
  if (action !== 'upload') return res.status(400).json({ error: 'Invalid action' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await verifyUser(req);
    const { fileName, fileData, contentType } = req.body; // base64 encoded file
    if (!fileData || !fileName) return res.status(400).json({ error: 'Missing file data' });

    const buffer = Buffer.from(fileData, 'base64');
    const path = `${user.id}/${Date.now()}_${fileName}`;
    const { data, error } = await supabaseAdmin.storage
      .from('proofs')
      .upload(path, buffer, { contentType, upsert: false });
    if (error) return res.status(400).json({ error: error.message });

    const { publicURL } = supabaseAdmin.storage.from('proofs').getPublicUrl(data.path);
    return res.status(200).json({ url: publicURL });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
