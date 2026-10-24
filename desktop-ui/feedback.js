export function showFlashToast(message, { ms = 2000 } = {}) {
  const existing = document.querySelector('#flash-toast');
  if (existing instanceof HTMLElement) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'flash-toast';
  toast.className = 'flash-toast';
  toast.textContent = String(message ?? '');
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, ms);
}
