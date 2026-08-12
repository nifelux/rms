/**
 * Utility Functions
 * Formatters (Naira), toast, loader, modal, image upload helper.
 */
export function formatCurrency(amount) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN'
  }).format(amount);
}

export function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-NG', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

export function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('en-NG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export function truncate(str, len = 50) {
  return str.length > len ? str.substring(0, len) + '...' : str;
}

/**
 * Toast notification
 * @param {string} message
 * @param {string} type 'success'|'error'|'info'
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `alert alert-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function createToastContainer() {
  const div = document.createElement('div');
  div.id = 'toast-container';
  div.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;';
  document.body.appendChild(div);
  return div;
}

/**
 * Simple Loader overlay
 */
export function showLoader() {
  const loader = document.getElementById('global-loader') || createLoader();
  loader.style.display = 'flex';
}
export function hideLoader() {
  const loader = document.getElementById('global-loader');
  if (loader) loader.style.display = 'none';
}
function createLoader() {
  const div = document.createElement('div');
  div.id = 'global-loader';
  div.innerHTML = '<div class="spinner"></div>';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);display:none;align-items:center;justify-content:center;z-index:9998';
  document.body.appendChild(div);
  const style = document.createElement('style');
  style.textContent = '.spinner{border:4px solid #f3f3f3;border-top:4px solid var(--clr-primary);border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  return div;
}

/**
 * Modal Manager
 */
export function openModal(id) {
  document.getElementById(id)?.classList.add('active');
}
export function closeModal(id) {
  document.getElementById(id)?.classList.remove('active');
}

/**
 * Image Upload Helper (using Supabase storage)
 * @param {File} file
 * @returns {Promise<string>} public URL
 */
export async function uploadImage(file, bucket = 'proofs') {
  const supabase = window.supabase;
  const fileName = `${Date.now()}_${file.name}`;
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(fileName, file);
  if (error) throw error;
  const { publicURL } = supabase.storage.from(bucket).getPublicUrl(data.path);
  return publicURL;
                                                }
