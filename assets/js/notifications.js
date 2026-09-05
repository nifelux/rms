// assets/js/notifications.js
(function() {
  // 1. Inject Custom CSS for Toasts and Modals
  const style = document.createElement('style');
  style.innerHTML = `
    /* Toast Container */
    .rms-toast-container { position: fixed; top: 80px; left: 50%; transform: translateX(-50%); z-index: 10000; display: flex; flex-direction: column; gap: 10px; pointer-events: none; width: 90%; max-width: 400px; }
    .rms-toast { background: #11163a; border: 1px solid #ffd700; color: white; padding: 16px; border-radius: 12px; display: flex; align-items: center; gap: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); pointer-events: auto; animation: slideDown 0.3s ease forwards; font-family: 'Inter', sans-serif; }
    .rms-toast.success { border-color: #2ecc71; }
    .rms-toast.error { border-color: #ff1a1a; }
    .rms-toast.info { border-color: #3498db; }
    .rms-toast-icon { font-size: 1.3rem; }
    .rms-toast.success .rms-toast-icon { color: #2ecc71; }
    .rms-toast.error .rms-toast-icon { color: #ff1a1a; }
    .rms-toast.info .rms-toast-icon { color: #3498db; }
    .rms-toast-message { flex: 1; font-size: 0.9rem; font-weight: 500; }
    @keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeOut { to { opacity: 0; transform: translateY(-20px); } }

    /* Custom Confirm Modal */
    .rms-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); z-index: 10001; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.2s ease; }
    .rms-modal { background: #11163a; border: 1px solid #ffd700; border-radius: 16px; padding: 24px; width: 90%; max-width: 350px; text-align: center; color: white; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
    .rms-modal h3 { margin: 0 0 12px 0; color: #ffd700; font-size: 1.2rem; }
    .rms-modal p { margin: 0 0 24px 0; color: #a0aec0; font-size: 0.95rem; line-height: 1.5; }
    .rms-modal-actions { display: flex; gap: 12px; justify-content: center; }
    .rms-modal-btn { padding: 10px 24px; border-radius: 8px; border: none; font-weight: 700; cursor: pointer; font-size: 0.9rem; transition: 0.2s; }
    .rms-modal-btn.cancel { background: rgba(255,255,255,0.1); color: white; }
    .rms-modal-btn.confirm { background: #ffd700; color: #0a0e27; }
    .rms-modal-btn.confirm.danger { background: #ff1a1a; color: white; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);

  // 2. Create Toast Container
  const container = document.createElement('div');
  container.className = 'rms-toast-container';
  document.body.appendChild(container);

  // 3. Global Functions
  window.showToast = function(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `rms-toast ${type}`;
    
    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-circle-xmark';
    
    toast.innerHTML = `
      <i class="fa-solid ${icon} rms-toast-icon"></i>
      <div class="rms-toast-message">${message}</div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  };

  window.showConfirm = function(message, onConfirm, isDanger = false) {
    const overlay = document.createElement('div');
    overlay.className = 'rms-modal-overlay';
    overlay.innerHTML = `
      <div class="rms-modal">
        <h3>Are you sure?</h3>
        <p>${message}</p>
        <div class="rms-modal-actions">
          <button class="rms-modal-btn cancel" id="rms-cancel">Cancel</button>
          <button class="rms-modal-btn confirm ${isDanger ? 'danger' : ''}" id="rms-confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    overlay.querySelector('#rms-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#rms-confirm').onclick = () => {
      overlay.remove();
      if (onConfirm) onConfirm();
    };
  };
})();
