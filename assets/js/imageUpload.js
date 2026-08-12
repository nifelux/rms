/**
 * Image Upload to Supabase Storage
 */
export async function uploadImage(file, bucket = 'proofs') {
  const supabase = window.supabase;
  if (!supabase) throw new Error('Supabase not initialized');
  const fileName = `${Date.now()}_${file.name}`;
  const { data, error } = await supabase.storage.from(bucket).upload(fileName, file);
  if (error) throw error;
  const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(data.path);
  return publicUrlData.publicUrl;
}
