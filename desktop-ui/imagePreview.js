import { t, ui } from './i18n.js';
import { installImageZoom } from './imageZoom.js';
const supportedTypes = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
  ['image/gif', 'gif'], ['image/avif', 'avif'], ['image/heic', 'heic'],
]);

export function imageDownloadName(label, type) {
  const stem = String(label || 'Melo-image').replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'Melo-image';
  return `${stem}.${supportedTypes.get(type) || 'png'}`;
}

// Keep the modal outside #app so streaming updates cannot close it or reset zoom.
export function installImagePreview({ saveNativeImage } = {}) {
  let current;
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-image-preview]');
    if (!trigger) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (current?.open) return;
    const source = trigger.querySelector('img');
    if (!source) return;
    const url = new URL(source.getAttribute('src'), location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol) && !/^data:image\//i.test(url.href)) return;
    const dialog = document.createElement('dialog');
    current = dialog;
    dialog.className = 'image-preview-dialog';
    dialog.setAttribute('aria-label', t("图片预览"));
    dialog.innerHTML = ui`<header class="image-preview-toolbar"><span class="image-preview-title"></span><button type="button" data-preview-zoom aria-label="原始尺寸" title="原始尺寸">100%</button><button type="button" data-preview-download aria-label="下载原图" title="下载原图"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></svg></button><button type="button" data-preview-close aria-label="关闭预览" title="关闭预览">×</button></header><div class="image-preview-stage"><img alt="" /></div><footer class="image-preview-status"><span class="image-preview-dimensions"></span><span role="status" aria-live="polite"></span></footer>`;
    const bitmap = dialog.querySelector('img');
    const status = dialog.querySelector('[role=status]');
    const dimensions = dialog.querySelector('.image-preview-dimensions');
    const download = dialog.querySelector('[data-preview-download]');
    const zoom = dialog.querySelector('[data-preview-zoom]');
    const label = source.alt || 'Melo-image';
    dialog.querySelector('.image-preview-title').textContent = label;
    bitmap.alt = label;
    bitmap.onload = () => { dimensions.textContent = `${bitmap.naturalWidth} × ${bitmap.naturalHeight}`; };
    bitmap.onerror = () => { dimensions.textContent = t("图片无法载入，文件可能已过期或不可用。"); };
    bitmap.src = url.href;
    dialog.querySelector('[data-preview-close]').onclick = () => dialog.close();
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    const abort = new AbortController();
    let disposeZoom;
    dialog.addEventListener('close', () => {
      disposeZoom?.(); abort.abort(); dialog.remove(); current = null;
      (trigger.isConnected ? trigger : document.querySelector('#composer'))?.focus({ preventScroll: true });
    }, { once: true });
    download.onclick = async () => {
      download.disabled = true; status.textContent = t("正在准备原图…");
      try {
        const response = await fetch(url.href, { signal: abort.signal });
        if (!response.ok) throw new Error(t("图片无法下载，请确认文件仍可用后重试。"));
        const blob = await response.blob();
        if (!supportedTypes.has(blob.type.toLowerCase())) throw new Error('返回的文件不是支持的图片格式。');
        if (blob.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MB，暂时无法下载。');
        if (!dialog.open) return;
        const name = imageDownloadName(label, blob.type.toLowerCase());
        if (saveNativeImage) {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('无法读取图片，请重试。'));
            reader.readAsDataURL(blob);
          });
          if (!dialog.open) return;
          const result = await saveNativeImage({ data: base64, name, mimeType: blob.type.toLowerCase() });
          status.textContent = result.cancelled ? t("已取消保存") : t("原图已保存");
        } else {
          const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
          link.href = objectUrl; link.download = name; document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
          status.textContent = t("已开始下载原图");
        }
      } catch (error) {
        if (!abort.signal.aborted) status.textContent = error.message || t("保存失败，请重试。");
      } finally { download.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal();
    disposeZoom = installImageZoom(dialog.querySelector('.image-preview-stage'), bitmap, zoom);
  }, true);
}
