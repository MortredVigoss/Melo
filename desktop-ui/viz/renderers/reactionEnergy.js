// Reaction energy diagram.
// Params: E_reactants, E_products, E_activation (height of the barrier above reactants)
// Draws a smooth potential-energy curve: flat → rise to transition state → fall to products.
import {
  bindParamSliders,
  escapeAttr,
  materializeParams,
  paramValue,
  renderCardFooter,
  renderCardHeader,
  renderParamsHtml,
  resizeCanvas,
  startAnimationLoop,
} from '../vizCommon.js';

const CANVAS_W = 460;
const CANVAS_H = 260;
const PADDING = 28;

const DEFAULTS = { E_reactants: 10, E_products: -20, E_activation: 40 };

export default function mountReactionEnergy(host, spec) {
  const params = materializeParams(spec.params);
  host.classList.add('viz-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <canvas class="viz-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    <div class="viz-readout" data-role="viz-readout"></div>
    ${renderParamsHtml(params)}
    ${renderCardFooter(spec)}
  `;
  const canvas = host.querySelector('canvas.viz-canvas');
  const readout = host.querySelector('[data-role="viz-readout"]');
  bindParamSliders(host, params, updateReadout);

  function updateReadout() {
    const Er = paramValue(params, 'E_reactants', DEFAULTS.E_reactants);
    const Ep = paramValue(params, 'E_products', DEFAULTS.E_products);
    const Ea = paramValue(params, 'E_activation', DEFAULTS.E_activation);
    const dH = Ep - Er;
    if (readout) {
      readout.textContent =
        `Eₐ = ${Ea.toFixed(1)} kJ/mol · ΔH = ${dH.toFixed(1)} kJ/mol (${dH < 0 ? 'exothermic' : 'endothermic'})`;
    }
  }
  updateReadout();

  return startAnimationLoop(host, () => {
    const Er = paramValue(params, 'E_reactants', DEFAULTS.E_reactants);
    const Ep = paramValue(params, 'E_products', DEFAULTS.E_products);
    const Ea = paramValue(params, 'E_activation', DEFAULTS.E_activation);
    const peak = Er + Ea;

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const yMin = Math.min(Ep, Er) - 10;
    const yMax = peak + 10;
    const plotW = CANVAS_W - PADDING * 2;
    const plotH = CANVAS_H - PADDING * 2;
    const toX = t => PADDING + t * plotW;
    const toY = v => PADDING + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // Axis.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING, PADDING);
    ctx.lineTo(PADDING, CANVAS_H - PADDING);
    ctx.moveTo(PADDING, CANVAS_H - PADDING);
    ctx.lineTo(CANVAS_W - PADDING, CANVAS_H - PADDING);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Energy', PADDING - 4, PADDING + 8);
    ctx.textAlign = 'left';
    ctx.fillText('Reaction →', PADDING + 6, CANVAS_H - PADDING + 14);

    // Curve segments: flat reactants (0-0.25), ramp (0.25-0.4),
    // smooth peak (0.4-0.6), fall (0.6-0.75), flat products (0.75-1).
    const points = [];
    const N = 220;
    for (let i = 0; i <= N; i += 1) {
      const t = i / N;
      let y;
      if (t < 0.22) y = Er;
      else if (t < 0.78) {
        // Cosine bell from Er up to peak and down to Ep, centered at t=0.5.
        const u = (t - 0.22) / 0.56;
        const bell = 0.5 - 0.5 * Math.cos(u * Math.PI);
        const baseline = Er + (Ep - Er) * u;
        const barrier = (peak - Math.max(Er, Ep)) * Math.sin(u * Math.PI);
        y = baseline + barrier * bell * (1 - bell) * 4;
        // simpler: use an explicit cosine bell for the activation barrier
        y = Er + (Ep - Er) * u + (peak - Math.max(Er, Ep)) * Math.sin(u * Math.PI);
      } else {
        y = Ep;
      }
      points.push({ t, y });
    }

    // Level labels.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(PADDING, toY(Er));
    ctx.lineTo(CANVAS_W - PADDING, toY(Er));
    ctx.moveTo(PADDING, toY(Ep));
    ctx.lineTo(CANVAS_W - PADDING, toY(Ep));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`E₁ = ${Er.toFixed(0)}`, PADDING + 4, toY(Er) - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`E₂ = ${Ep.toFixed(0)}`, CANVAS_W - PADDING - 4, toY(Ep) - 4);

    // Curve.
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
    grad.addColorStop(0, 'rgba(246,90,96,0.95)');
    grad.addColorStop(1, 'rgba(255,176,120,0.95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    points.forEach((pt, i) => {
      const x = toX(pt.t);
      const y = toY(pt.y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Mark activation peak.
    ctx.fillStyle = '#fff7f3';
    ctx.beginPath();
    ctx.arc(toX(0.5), toY(peak), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.fillText(`Eₐ`, toX(0.5), toY(peak) - 8);
  });
}
