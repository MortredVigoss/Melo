// Deliberately standalone: the native startup page runs before the local server,
// module graph and WebGL are available. The same resource is used by the web UI.
(() => {
  const phases = {
    service: ['正在启动 Melo', '连接本地工作空间'],
    workspace: ['正在打开你的工作空间', '载入对话与偏好设置'],
    error: ['暂时无法打开工作空间', '可以重试，已有内容会保留。'],
  };
  // BEGIN GENERATED LAUNCH COPY
  const launchCopy = {"正在启动 Melo":{"zh-CN":"正在启动 Melo","en":"Starting Melo","ja":"Melo を起動中","ko":"Melo 시작 중","es":"Iniciando Melo"},"连接本地工作空间":{"zh-CN":"连接本地工作空间","en":"Connecting to your local workspace","ja":"ローカルワークスペースに接続中","ko":"로컬 작업 공간에 연결 중","es":"Conectando al espacio local"},"正在打开你的工作空间":{"zh-CN":"正在打开你的工作空间","en":"Opening your workspace","ja":"ワークスペースを開いています","ko":"작업 공간 여는 중","es":"Abriendo tu espacio"},"载入对话与偏好设置":{"zh-CN":"载入对话与偏好设置","en":"Loading conversations and preferences","ja":"会話と設定を読み込み中","ko":"대화 및 설정 불러오는 중","es":"Cargando conversaciones y preferencias"},"暂时无法打开工作空间":{"zh-CN":"暂时无法打开工作空间","en":"Unable to open the workspace","ja":"ワークスペースを開けません","ko":"작업 공간을 열 수 없습니다","es":"No se puede abrir el espacio"},"可以重试，已有内容会保留。":{"zh-CN":"可以重试，已有内容会保留。","en":"Try again. Existing content will be preserved.","ja":"再試行できます。既存の内容は保持されます。","ko":"다시 시도할 수 있으며 기존 내용은 유지됩니다.","es":"Puedes reintentar. Se conservará el contenido."},"没有可用的诊断详情。":{"zh-CN":"没有可用的诊断详情。","en":"No diagnostic details available.","ja":"診断情報はありません。","ko":"진단 정보가 없습니다.","es":"No hay detalles de diagnóstico."},"Melo 启动":{"zh-CN":"Melo 启动","en":"Melo startup","ja":"Melo の起動","ko":"Melo 시작","es":"Inicio de Melo"},"重新打开":{"zh-CN":"重新打开","en":"Reopen","ja":"再度開く","ko":"다시 열기","es":"Reabrir"},"查看诊断信息":{"zh-CN":"查看诊断信息","en":"Show diagnostics","ja":"診断情報を表示","ko":"진단 정보 보기","es":"Ver diagnóstico"}};
  // END GENERATED LAUNCH COPY
  function launchText(key) {
    const language = String(state.language || navigator.language || 'en').split('-')[0];
    return launchCopy[key]?.[language === 'zh' ? 'zh-CN' : language] || launchCopy[key]?.en || key;
  }
  let root, canvas, ctx, resizeObserver, removalObserver, raf = 0, lastFrame = 0;
  let state = {}, width = 0, height = 0, core = { x: 0, y: 0, radius: 80 };
  let retry = () => location.reload();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let seed = 7263;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const stars = Array.from({ length: 540 }, () => [random(), random(), random(), random() * 6.28]);
  const colors = ['210,167,101', '145,74,81', '129,99,150', '106,139,147', '163,113,81'];
  const points = Array.from({ length: 780 }, (_, i) => {
    const group = i % 5, a = group * Math.PI * 2 / 5 - Math.PI / 2;
    const phi = random() * Math.PI * 2, z = random() * 2 - 1, r = Math.cbrt(random()) * .64;
    const horizontal = Math.sqrt(1 - z * z) * r;
    return [Math.cos(a) * .36 + Math.cos(phi) * horizontal,
      Math.sin(a) * .36 + Math.sin(phi) * horizontal, z * r, group, random()];
  });
  const edges = [];
  for (let i = 0; i < 180; i++) {
    let nearest = -1, distance = Infinity;
    for (let j = i + 1; j < 220; j++) {
      const a = points[i], b = points[j];
      if (a[3] !== b[3]) continue;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < distance) { nearest = j; distance = d; }
    }
    if (nearest >= 0 && distance < .65) edges.push([i, nearest]);
  }

  function show(next = {}, onRetry) {
    if (onRetry) retry = onRetry;
    state = { ...state, ...next };
    if (!root?.isConnected) mount();
    const phase = phases[state.phase] ? state.phase : 'workspace';
    root.dataset.phase = phase;
    root.setAttribute('aria-busy', phase === 'error' ? 'false' : 'true');
    root.querySelector('[data-launch-status]').textContent = launchText(phases[phase][0]);
    root.querySelector('[data-launch-caption]').textContent = launchText(phases[phase][1]);
    root.querySelector('[data-launch-recovery]').hidden = phase !== 'error';
    root.querySelector('[data-launch-detail]').textContent = String(state.detail || launchText('没有可用的诊断详情。'));
    root.querySelector('details').hidden = !state.detail;
    root.querySelector('button').disabled = false;
    root.querySelector('button').textContent = launchText('重新打开');
    root.querySelector('summary').textContent = launchText('查看诊断信息');
    root.setAttribute('aria-label', launchText('Melo 启动'));
    draw();
  }

  function mount() {
    dispose();
    root = document.createElement('section');
    root.className = 'melo-launch';
    root.setAttribute('aria-label', 'Melo 启动');
    root.innerHTML = `<canvas aria-hidden="true"></canvas>
      <header class="melo-launch-header">MELO / WORKSPACE</header>
      <main class="melo-launch-body">
        <div class="melo-launch-core" aria-hidden="true"></div>
        <h1>melo</h1><p class="melo-launch-signature">A CONNECTED WORKSPACE</p>
        <div role="status" aria-live="polite"><div class="melo-launch-status"><i class="melo-launch-signal" aria-hidden="true"></i><span data-launch-status></span></div>
          <p class="melo-launch-caption" data-launch-caption></p></div>
        <div class="melo-launch-recovery" data-launch-recovery hidden>
          <button type="button">重新打开</button>
          <details><summary>查看诊断信息</summary><pre data-launch-detail></pre></details>
        </div>
      </main><footer class="melo-launch-footer">NEURAL WORKSPACE</footer>`;
    const host = document.getElementById('app') || document.body;
    host.append(root);
    root.querySelector('button').addEventListener('click', event => {
      event.currentTarget.disabled = true;
      if (document.body.dataset.nativeLaunch === 'true') {
        window.webkit?.messageHandlers?.meloVoice?.postMessage({ action: 'retryLaunch' });
      } else retry();
    });
    canvas = root.querySelector('canvas');
    try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    resizeObserver.observe(root.querySelector('.melo-launch-body'));
    removalObserver = new MutationObserver(() => { if (!root?.isConnected) dispose(); });
    removalObserver.observe(host, { childList: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', dispose);
    reduced.addEventListener('change', visibility);
    resize();
    visibility();
  }

  function resize() {
    if (!root || !canvas) return;
    width = window.innerWidth; height = window.innerHeight;
    const pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * pixelRatio); canvas.height = Math.round(height * pixelRatio);
    ctx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const bounds = root.querySelector('.melo-launch-core').getBoundingClientRect();
    core = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, radius: Math.min(bounds.height * .48, 110) };
    draw();
  }

  function draw() {
    if (!ctx || !root?.isConnected) return;
    const t = reduced.matches ? 0 : Date.now() / 1000;
    ctx.clearRect(0, 0, width, height);
    for (const [x, y, r, phase] of stars) {
      ctx.fillStyle = `rgba(194,178,145,${.055 + r * r * .24 + Math.sin(t * .23 + phase) * .018})`;
      ctx.fillRect(x * width, y * height, .45 + r * .65, .45 + r * .65);
    }
    const yaw = .5 + Math.sin(t * .085) * .35, tilt = .25 + Math.sin(t * .09) * .12;
    const projected = points.map(([x, y, z, group, glow]) => {
      const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = z * Math.cos(yaw) - x * Math.sin(yaw);
      const ry = y * Math.cos(tilt) - rz * Math.sin(tilt), depth = rz * Math.cos(tilt) + y * Math.sin(tilt);
      const perspective = 3.8 / (3.8 - depth);
      return [core.x + rx * core.radius * perspective, core.y + ry * core.radius * perspective, depth, group, glow, perspective];
    });
    const dim = state.phase === 'error' ? .55 : 1;
    ctx.lineWidth = .45;
    edges.forEach(([i, j], index) => {
      const a = projected[i], b = projected[j];
      ctx.strokeStyle = `rgba(${colors[a[3]]},${(.035 + (a[2] + 1) * .055) * dim})`;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (index % 16 === 0) {
        const p = (t * .18 + index * .13) % 1;
        ctx.fillStyle = `rgba(234,211,165,${.34 * dim})`;
        ctx.fillRect(a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, 1.1, 1.1);
      }
    });
    projected.sort((a, b) => a[2] - b[2]).forEach(([x, y, depth, group, glow, perspective]) => {
      const alpha = (.12 + (depth + 1) * .20 + glow * glow * .24) * dim;
      ctx.fillStyle = `rgba(${glow > .83 ? '222,202,164' : colors[group]},${alpha})`;
      const radius = (.35 + glow * .55) * perspective;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
      if (glow > .96) {
        ctx.fillStyle = `rgba(211,178,125,${.07 * dim})`;
        ctx.beginPath(); ctx.arc(x, y, radius * 3.5, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  function frame(now) {
    if (!root?.isConnected) { dispose(); return; }
    if (now - lastFrame >= 1000 / 30) { lastFrame = now; draw(); }
    raf = requestAnimationFrame(frame);
  }
  function visibility() {
    cancelAnimationFrame(raf); raf = 0;
    root?.classList.toggle('is-paused', document.hidden || reduced.matches);
    if (!document.hidden && !reduced.matches && ctx) raf = requestAnimationFrame(frame);
    else if (!document.hidden) draw();
  }
  function dispose() {
    cancelAnimationFrame(raf); raf = 0;
    resizeObserver?.disconnect(); removalObserver?.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', dispose);
    reduced.removeEventListener('change', visibility);
    ctx = null;
  }
  function dismiss() {
    dispose(); root?.remove(); root = null;
    document.getElementById('app')?.classList.add('is-launch-arriving');
  }
  window.MeloLaunch = { show, dismiss, setLanguage(value) { state.language=value; if(root?.isConnected)show(); } };
  let initial = { phase: 'workspace' };
  try { initial = JSON.parse(document.getElementById('melo-launch-state')?.textContent || '{}'); } catch {}
  show(initial);
})();
