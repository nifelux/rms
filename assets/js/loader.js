/**
 * Global Loader
 */
export function showLoader() {
  let loader = document.getElementById('global-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'global-loader';
    loader.innerHTML = '<div class="spinner"></div>';
    loader.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);display:none;align-items:center;justify-content:center;z-index:9998';
    document.body.appendChild(loader);
    const style = document.createElement('style');
    style.textContent = '.spinner{border:4px solid #f3f3f3;border-top:4px solid var(--clr-primary);border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite}@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }
  loader.style.display = 'flex';
}

export function hideLoader() {
  const loader = document.getElementById('global-loader');
  if (loader) loader.style.display = 'none';
}
