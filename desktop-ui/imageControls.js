import { t, ui } from './i18n.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';
const settingsEdit = new EditSession();
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let draft = null,
  settingsDraft = null,
  status = '',
  busy = false;
const opts = (items, value) =>
  items
    .map(
      ([id, label]) =>
        ui`<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(label)}</option>`,
    )
    .join('');
const profiles = (config, apiOnly = false) =>
  (config.llmConnections?.profiles || [])
    .filter(
      (p) => !apiOnly || (p.authMode === 'api-key' && p.apiProtocol !== 'anthropic' && p.hasKey),
    )
    .map((p) => [p.id, `${p.name} · ${p.model || t("未选模型")}`]);
const defaults = {
  engine: 'codex-oauth',
  profileId: '',
  model: 'gpt-image-2.5-sunburst',
  codexModel: 'gpt-6.1-sol',
  visionProfileId: '',
  detail: 'auto',
  quality: 'high',
  size: 'auto',
  previews: false,
  inspectEdits: false,
};
const settingsFor = (config) => ({
  ...defaults,
  engine:
    config.imageEngine === 'auto' || config.imageEngine === 'codex'
      ? 'codex-oauth'
      : config.imageEngine || defaults.engine,
  codexModel:
    config.authMode === 'codex' ? config.model || defaults.codexModel : defaults.codexModel,
  ...config.imageSettings,
});
export function renderImageSettings(config) {
  const value = settingsDraft || settingsFor(config);
  return ui`<section class="surface-card image-settings"><h2 class="pane-title">图片能力</h2><p class="page-kicker">识图连接与图片生成服务独立选择。API 使用对应账户额度；没有权限或参数不支持时会报告失败。</p><div class="config-form">${renderEditActions(settingsEdit,{prefix:'image-settings'})}<fieldset class="settings-connection-fields" ${!settingsEdit.editing||busy?'disabled':''}>
    <label class="label">视觉模型<select class="config-select" data-image-setting="visionProfileId">${opts([['', t("沿用当前聊天模型")], ...profiles(config)], value.visionProfileId)}</select></label>
    <label class="label">图片生成服务<select class="config-select" data-image-setting="engine">${opts(
      [
        ['codex-oauth', 'ChatGPT / Codex OAuth'],
        ['openai-api', t("OpenAI Images 兼容 API")],
        ['sdcpp', t("本地 sd.cpp")],
        ['minimax', 'MiniMax API'],
      ],
      value.engine,
    )}</select></label>
    ${['codex-oauth', 'openai-api'].includes(value.engine) ? ui`<label class="label">质量<select class="config-select" data-image-setting="quality">${opts(
            [
              ['auto', t("自动")],
              ['low', t("低")],
              ['medium', t("中")],
              ['high', t("高")],
            ],
            value.quality,
          )}</select></label>` : ''}
    ${value.engine === 'codex-oauth' ? ui`<label class="label">图片请求使用的语言模型<input class="config-input" data-image-setting="codexModel" value="${esc(value.codexModel)}" placeholder="gpt-6.1-sol / gpt-6-astra"></label>` : ''}
    ${
      value.engine === 'openai-api'
        ? ui`<label class="label">图像 API 连接<select class="config-select" data-image-setting="profileId">${opts([['', t("请选择已保存的 API 连接")], ...profiles(config, true)], value.profileId)}</select></label><label class="label">图像模型 ID<input class="config-input" data-image-setting="model" value="${esc(value.model)}"></label><label class="label">尺寸<select class="config-select" data-image-setting="size">${opts(
            [
              ['auto', t("自动")],
              ['1024x1024', t("正方形")],
              ['1536x1024', t("横向")],
              ['1024x1536', t("纵向")],
            ],
            value.size,
          )}</select></label><label><input type="checkbox" data-image-setting="previews" ${value.previews ? 'checked' : ''}> 请求生成中的预览（可能增加用量；通道需支持流式图像）</label>`
        : ui`<p class="list-row-meta">当前通道按实际返回展示预览。质量按选择请求，最终以服务返回为准；局部遮罩与明确尺寸需使用支持这些参数的图像 API。</p>`
    }
    <label><input type="checkbox" data-image-setting="inspectEdits" ${value.inspectEdits ? 'checked' : ''}> 改图后核对修改与保留项（每张额外一次视觉请求，不自动重生成）</label>
    </fieldset><p role="status">${esc(status)}</p>
  </div></section>`;
}
export function renderImageTaskControls(attachments = []) {
  const images = attachments.filter((a) => a.kind === 'image');
  if (draft) {
    draft.references = draft.references.filter((r) => images.some((a) => a.id === r.attachmentId));
    if (draft.mask && draft.maskSourceId !== images[0]?.id) {
      delete draft.mask;
      delete draft.maskSourceId;
    }
  }
  return ui`<div class="image-task-options"><button type="button" class="small-button" data-action="image-task-toggle">${draft ? t("收起图片选项") : t("图片选项")}</button>${
    draft
      ? ui`<div class="image-task-fields">
    <label>数量<input type="number" min="1" max="20" data-image-task="count" placeholder="按要求，默认 1" value="${esc(draft.count || '')}"></label>
    <label>输入精度<select data-image-task="detail">${opts(
            [
              ['auto', t("模型默认")],
              ['high', t("高清")],
              ['original', t("原图细节（模型需支持）")],
            ],
            draft.detail,
          )}</select></label><label><input type="checkbox" data-image-task="ocr" ${draft.ocr ? 'checked' : ''}> OCR 交叉核对文字</label>
    ${images
      .map((a) => {
        const ref = draft.references.find((r) => r.attachmentId === a.id) || { role: 'reference' };
        return ui`<div class="image-reference-row"><span>${esc(a.title || t("参考图"))}</span><select aria-label="参考图用途" data-image-reference="${esc(a.id)}">${opts(
          [
            ['reference', t("原图参考")],
            ['subject', t("主体与身份")],
            ['style', t("风格")],
            ['composition', t("构图")],
          ],
          ref.role,
        )}</select>${images.length ? ui`<details><summary>只查看指定区域（百分比）</summary>${['x', 'y', 'width', 'height'].map((k, i) => ui`<label>${[t("左"), t("上"), t("宽"), t("高")][i]}<input type="number" min="0" max="100" data-image-crop="${k}" data-image-reference-id="${esc(a.id)}" value="${ref.crop?.[k] ?? (i < 2 ? 0 : 100)}"></label>`).join('')}</details>` : ''}</div>`;
      })
      .join('')}
    ${images.length ? ui`<div class="inline-actions"><button type="button" class="small-button" data-action="image-mask">${draft.mask ? t("重画局部遮罩") : t("绘制局部遮罩")}</button>${draft.mask ? ui`<button class="small-button" data-action="image-mask-clear">移除遮罩</button><span>仅修改透明区域</span>` : ''}</div>` : ''}
    ${draft.action !== 'analyze' ? ui`<label><input type="checkbox" data-image-task="inspect" ${draft.inspect ? 'checked' : ''}> 核对生成结果（每张额外一次视觉请求，不自动重生成）</label>` : ''}
    <p class="list-row-meta">${draft.action === 'analyze' ? t("原图保留，裁切只用于本次识别。") : '保留你的完整要求，区分修改目标与保留项。核对是模型判断，结果会随图片显示；不自动重生成或跨平台重试。'}</p>
  </div>`
      : ''
  }</div>`;
}
export function consumeImageTask() {
  const value = draft ? structuredClone(draft) : null;
  draft = null;
  return value;
}
export function restoreImageTask(value) {
  draft = value ? { ...structuredClone(value), action: 'auto' } : null;
}
export function clearImageTask() {
  draft = null;
}
export function handleImageInput(target, config) {
  if (target.dataset.imageSetting) {
    if (!settingsEdit.editing || busy) return true;
    settingsEdit.change();
    const bar=target.closest?.('.image-settings')?.querySelector('.settings-edit-toolbar');
    paintEditActions(bar,settingsEdit,{prefix:'image-settings'});
    settingsDraft ||= settingsFor(config);
    settingsDraft[target.dataset.imageSetting] =
      target.type === 'checkbox' ? target.checked : target.value;
    return true;
  }
  if (!draft) return false;
  if (target.dataset.imageTask) {
    draft[target.dataset.imageTask] =
      target.type === 'checkbox'
        ? target.checked
        : target.dataset.imageTask === 'count'
          ? target.value
            ? Number(target.value)
            : undefined
          : target.value;
    return true;
  }
  const id = target.dataset.imageReference || target.dataset.imageReferenceId;
  if (id) {
    let ref = draft.references.find((r) => r.attachmentId === id);
    if (!ref) {
      ref = { attachmentId: id, role: 'reference' };
      draft.references.push(ref);
    }
    if (target.dataset.imageCrop) {
      ref.crop ||= { x: 0, y: 0, width: 100, height: 100 };
      ref.crop[target.dataset.imageCrop] = Number(target.value);
    } else ref.role = target.value;
    return true;
  }
  return false;
}
export async function handleImageAction(action, { config, attachments, api, render, refresh }) {
  if (!action.startsWith('image-')) return false;
  if (action === 'image-task-toggle')
    draft = draft
      ? null
      : {
          action: 'auto',
          references: [],
          detail: 'auto',
        };
  if (action === 'image-mask-clear' && draft) delete draft.mask;
  if (action.startsWith('image-settings-') && busy) return true;
  if (action === 'image-settings-edit') { settingsEdit.begin();status=''; }
  if (action === 'image-settings-cancel') { settingsEdit.cancel();settingsDraft=null;status='';globalThis.document?.querySelector('.image-settings fieldset')?.remove(); }
  if (action === 'image-settings-save') {
    if (!settingsEdit.start()) return true;
    busy = true;
    status = t("正在保存…");
    render();
    try {
      await api('/api/settings/model', {
        method: 'POST',
        body: { imageSettings: settingsDraft || settingsFor(config) },
      });
      settingsDraft = null;
      settingsEdit.saved();
      status = t("已保存；下一次图片任务使用这些设置。");
      await refresh();
    } catch (e) {
      if(settingsEdit.status!=='saved')settingsEdit.failed(e);
      status = e.message;
    } finally {
      busy = false;
    }
  }
  if (action === 'image-mask' && draft) {
    if ((config.imageSettings?.engine || 'codex-oauth') !== 'openai-api') {
      status = '局部遮罩需要图像 API，请先在系统 → 模型中选择。';
      window.alert(status);
      return true;
    }
    const source = attachments.find((a) => a.kind === 'image');
    if (!source) {
      window.alert(t("请先附加要修改的原图。"));
      return true;
    }
    const value = await drawMask(source.url);
    if (value) {
      draft.mask = value;
      draft.maskSourceId = source.id;
    }
  }
  render();
  return true;
}
async function drawMask(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  if (img.naturalWidth * img.naturalHeight > 20_000_000)
    throw new Error('局部编辑原图过大，请先缩小至 2000 万像素以内。');
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'image-mask-dialog';
    dialog.innerHTML =
      ui`<h3>涂抹要修改的区域</h3><p>粉色涂抹处会变成透明遮罩；第一张参考图作为编辑原图。</p><div class="image-mask-surface"></div><div class="inline-actions"><button data-mask-clear>清空</button><button data-mask-cancel>取消</button><button data-mask-save>使用遮罩</button></div>`;
    const area = dialog.querySelector('.image-mask-surface');
    area.append(img);
    const overlay = document.createElement('canvas'),
      mask = document.createElement('canvas');
    overlay.width = mask.width = img.naturalWidth;
    overlay.height = mask.height = img.naturalHeight;
    area.append(overlay);
    const ctx = overlay.getContext('2d'),
      m = mask.getContext('2d');
    let painting = false,
      previous = null,
      painted = false;
    const reset = () => {
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      m.globalCompositeOperation = 'source-over';
      m.fillStyle = '#000';
      m.fillRect(0, 0, mask.width, mask.height);
      m.globalCompositeOperation = 'destination-out';
      painted = false;
    };
    reset();
    const point = (e) => {
      const r = overlay.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) * overlay.width) / r.width,
        y: ((e.clientY - r.top) * overlay.height) / r.height,
      };
    };
    const draw = (e) => {
      if (!painting) return;
      const p = point(e);
      for (const c of [ctx, m]) {
        c.lineWidth = overlay.width / 24;
        c.lineCap = 'round';
        c.strokeStyle = c === ctx ? 'rgba(177,102,184,.55)' : '#000';
        c.beginPath();
        c.moveTo(previous?.x ?? p.x, previous?.y ?? p.y);
        c.lineTo(p.x + (previous ? 0 : 0.01), p.y);
        c.stroke();
      }
      previous = p;
      painted = true;
    };
    overlay.onpointerdown = (e) => {
      painting = true;
      previous = null;
      overlay.setPointerCapture(e.pointerId);
      draw(e);
    };
    overlay.onpointermove = draw;
    overlay.onpointerup = () => {
      painting = false;
      previous = null;
    };
    overlay.onpointercancel = overlay.onpointerup;
    const close = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.querySelector('[data-mask-clear]').onclick = reset;
    dialog.querySelector('[data-mask-cancel]').onclick = () => close(null);
    dialog.querySelector('[data-mask-save]').onclick = () => {
      if (painted) close(mask.toDataURL('image/png'));
    };
    dialog.oncancel = (e) => {
      e.preventDefault();
      close(null);
    };
    document.body.append(dialog);
    dialog.showModal();
  });
}
