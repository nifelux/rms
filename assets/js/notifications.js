(function() {
  // Inject CSS with !important to override everything
  const style = document.createElement('style');
  style.innerHTML = `
    .rms-toast-container { 
      position: fixed !important;
      top: 100px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      z-index: 999999 !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 10px !important;
      pointer-events: none !important;
      width: 90% !important;
      max-width: 400px !important;
    }
    .rms-toast { 
      background: #11163a !important;
      border: 2px solid #ffd700 !important;
      color: white !important;
      padding: 18px 20px !important;
      border-radius: 12px !important;
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      box-shadow: 0 10px 40px rgba(0,0,0,0.8), 0 0 20px rgba(255,215,0,0.3) !important;
      pointer-events: auto !important;
      animation: slideDown 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards !important;
      font-family: 'Inter', sans-serif !important;
      min-width: 280px !important;
    }
    .rms-toast.success { 
      border-color: #2ecc71 !important; 
      background: linear-gradient(135deg, #0f2b1d, #1a3d2e) !important;
    }
    .rms-toast.error { 
      border-color: #ff1a1a !important; 
      background: linear-gradient(135deg, #2b0f0f, #3d1a1a) !important;
    }
    .rms-toast.info { 
      border-color: #3498db !important; 
      background: linear-gradient(135deg, #0f1d2b, #1a2e3d) !important;
    }
    .rms-toast-icon { 
      font-size: 1.5rem !important;
      flex-shrink: 0 !important;
    }
    .rms-toast.success .rms-toast-icon { color: #2ecc71 !important; }
    .rms-toast.error .rms-toast-icon { color: #ff1a1a !important; }
    .rms-toast.info .rms-toast-icon { color: #3498db !important; }
    .rms-toast-message { 
      flex: 1 !important; 
      font-size: 0.95rem !important; 
      font-weight: 600 !important;
      line-height: 1.4 !important;
    }
    
    @keyframes slideDown { 
      from { opacity: 0; transform: translateY(-50px) scale(0.8); } 
      to { opacity: 1; transform: translateY(0) scale(1); } 
    }
    @keyframes fadeOut { 
      to { opacity: 0; transform: translateY(-20px); } 
    }

    .rms-modal-overlay { 
      position: fixed !important;
      inset: 0 !important;
      background: rgba(0,0,0,0.9) !important;
      backdrop-filter: blur(5px) !important;
      z-index: 999998 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      animation: fadeIn 0.2s ease !important;
    }
    .rms-modal { 
      background: #11163a !important;
      border: 2px solid #ffd700 !important;
      border-radius: 16px !important;
      padding: 28px !important;
      width: 85% !important;
      max-width: 350px !important;
      text-align: center !important;
      color: white !important;
      box-shadow: 0 20px 60px rgba(0,0,0,0.9) !important;
    }
    .rms-modal h3 { margin: 0 0 12px 0; color: #ffd700; font-size: 1.3rem; }
    .rms-modal p { margin: 0 0 24px 0; color: #a0aec0; font-size: 0.95rem; line-height: 1.5; }
    .rms-modal-actions { display: flex; gap: 12px; justify-content: center; }
    .rms-modal-btn { padding: 12px 28px; border-radius: 8px; border: none; font-weight: 700; cursor: pointer; font-size: 0.95rem; transition: 0.2s; }
    .rms-modal-btn.cancel { background: rgba(255,255,255,0.1); color: white; }
    .rms-modal-btn.confirm { background: #ffd700; color: #0a0e27; }
    .rms-modal-btn.confirm.danger { background: #ff1a1a; color: white; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);

  // Create container
  const container = document.createElement('div');
  container.className = 'rms-toast-container';
  container.id = 'rms-toast-container';
  document.body.appendChild(container);

  // Global showToast function
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
    
    const container = document.getElementById('rms-toast-container');
    if (container) {
      container.appendChild(toast);
      
      setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
      }, duration);
    }
  };

  // Global showConfirm function
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
    
    overlay.querySelector('#rms-cancel').onclick = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    overlay.querySelector('#rms-confirm').onclick = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (onConfirm) onConfirm();
    };
  };
  
  console.log('✅ Notification system loaded');
})();
