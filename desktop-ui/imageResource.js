import { t } from './i18n.js';

const resolutions = new WeakMap();
function legacyWorkspaceUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/api/files/signed/');
  } catch { return false; }
}
export async function imageResponseError(response, fallback) {
  try { const value = await response.json(); if (value?.error) return t(value.error); } catch {}
  return t(fallback);
}

// One shared resolution for chat, preview and save. The server accepts saved
// message/attachment identities, not the path embedded in a stale URL.
export async function resolveImageSource(image, { signal } = {}) {
  if (image.dataset.resolvedImageUrl) return image.dataset.resolvedImageUrl;
  const source = image.getAttribute('src');
  if (!legacyWorkspaceUrl(source) || !image.dataset.imageRef) return source;
  if (!resolutions.has(image)) {
    const reference = JSON.parse(image.dataset.imageRef);
    const query = new URLSearchParams({ ...reference, url: source });
    const pending = fetch(`/api/media/images/resolve?${query}`, { signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error(await imageResponseError(response, '图片暂时无法读取，请重试。'));
      const result = await response.json();
      if (typeof result.url !== 'string' || !/^\/api\/media\/images\/[a-f0-9]{24}\//.test(result.url)) throw new Error(t('图片访问地址无效。'));
      image.dataset.resolvedImageUrl = result.url;
      image.src = result.url;
      return result.url;
    }).catch(error => { resolutions.delete(image); throw error; });
    resolutions.set(image, pending);
  }
  return resolutions.get(image);
}

export function installImageRecovery() {
  const inspected = new WeakSet();
  const showError = (image, error) => {
    image.title = error.message;
    const caption = image.closest('figure')?.querySelector('figcaption');
    if (caption) { caption.textContent = error.message; caption.setAttribute('role', 'status'); }
  };
  const prepare = image => {
    if (inspected.has(image) || !image.dataset.imageRef || !legacyWorkspaceUrl(image.getAttribute('src'))) return;
    inspected.add(image);
    image.dataset.recoveryAttempted = '1';
    resolveImageSource(image).catch(error => showError(image, error));
  };
  const scan = node => {
    if (node.nodeType !== 1) return;
    if (node.matches('img[data-image-ref]')) prepare(node);
    node.querySelectorAll('img[data-image-ref]').forEach(prepare);
  };
  scan(document.documentElement);
  // Bootstrap and streaming replace chat DOM. Resolve new saved-image cards
  // once; changing src after resolution does not trigger another inspection.
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(scan)))
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('error', async event => {
    const image = event.target;
    if (image?.tagName !== 'IMG' || !image.dataset.imageRef) return;
    if (!inspected.has(image)) { prepare(image); return; }
    if (!image.dataset.resolvedImageUrl || image.dataset.imageErrorReported) return;
    if (!image.complete || image.naturalWidth > 0) return;
    image.dataset.imageErrorReported = '1';
    try {
      // At most one diagnostic request after a resolved image fails to decode.
      const response = await fetch(image.dataset.resolvedImageUrl);
      if (!response.ok) throw new Error(await imageResponseError(response, '图片暂时无法读取，请重试。'));
      response.body?.cancel();
      throw new Error(t('图片已损坏或浏览器不支持此格式。'));
    } catch (error) { showError(image, error); }
  }, true);
}
