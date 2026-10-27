import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { renderNeuralNavigation, renderNeuralOverview } from './neuralShell.js';
import { setLanguage } from './i18n.js';

// Exercise the production stylesheet cascade and measured spatial layout, not
// a hand-picked subset of CSS that misses a later, more specific override.
async function fixture(t) {
  const browser = await launchTestChrome(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
  const index = await readFile('desktop-ui/index.html', 'utf8');
  const sheets = [...index.matchAll(/<link[^>]+href="([^"?]+\.css)[^"]*"/g)].map(m => m[1].replace(/^\//, ''));
  const css = (await Promise.all(sheets.map(p => readFile(`desktop-ui/${p}`, 'utf8')))).join('\n');
  setLanguage('zh-CN');
  const data = { settings: {}, chats: [], projects: [], customize: { agents: [] } };
  const html = `<style>${css}</style><div id="app"><div class="shell neural-shell is-overview" data-neural-stage="overview" data-spatial-ready="true">
    <div class="neural-cosmos" data-renderer="webgl"></div><div class="neural-core-anchor"></div>
    ${renderNeuralNavigation(data, 'chat', { overview: true })}
    <div class="workspace neural-dashboard">${renderNeuralOverview(data, 'chat', { composer: '<div style="height:180px"></div>' })}</div>
  </div></div><script type="module">
    import { positionNeuralWorkspace } from '/neuralMotion.js';
    const root = document.querySelector('.neural-shell');
    const resize = () => positionNeuralWorkspace(root);
    new ResizeObserver(resize).observe(root);
    resize(); document.body.dataset.ready = 'true';
  </script>`;
  await page.route('http://melo-ui.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (!['/neuralMotion.js', '/neuralLayout.js'].includes(path)) return route.abort();
    await route.fulfill({ contentType: 'text/javascript', body: await readFile(`desktop-ui${path}`, 'utf8') });
  });
  await page.goto('http://melo-ui.test/');
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  return page;
}

test('neural entry tissue stays borderless when selected, hovered and keyboard focused', { timeout: 30000 }, async t => {
  const page = await fixture(t);
  for (const group of ['chat', 'projects', 'agents', 'knowledge', 'system']) {
    const target = page.locator(`.neural-cluster[data-group="${group}"]`);
    // All five can become the active module; state changes must never restore
    // the old glass disc over their continuously rendered tissue.
    await target.evaluate(el => {
      el.parentElement.querySelectorAll('.is-active').forEach(e => e.classList.remove('is-active'));
      el.classList.add('is-active');
    });
    for (const state of ['selected', 'hover', 'focus']) {
      if (state === 'hover') await target.hover();
      if (state === 'focus') { await page.mouse.move(0, 0); await target.press('Shift'); }
      await page.waitForTimeout(400);
      const style = await target.locator('.neural-orb').evaluate(el => {
        const s = getComputedStyle(el);
        return { image: s.backgroundImage, color: s.backgroundColor, border: s.borderTopColor, shadow: s.boxShadow, width: el.clientWidth };
      });
      assert.equal(style.image, 'none', `${group}/${state}: no opaque orb over the neural tissue`);
      assert.equal(style.color, 'rgba(0, 0, 0, 0)', `${group}/${state}: transparent fill`);
      assert.equal(style.border, 'rgba(0, 0, 0, 0)', `${group}/${state}: no circular rim`);
      assert.equal(style.shadow, 'none', `${group}/${state}: no disc shadow`);
      assert.ok(style.width >= 75, 'the invisible hit target retains its size');
    }
  }
});

test('home dock does not inherit old panel insets and displace the constellation', { timeout: 30000 }, async t => {
  const page = await fixture(t);
  for (const [width, height] of [[900, 660], [1320, 860], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(850);
    const metrics = await page.evaluate(() => {
      const home = document.querySelector('.neural-overview');
      const dock = document.querySelector('.neural-dashboard');
      return { padding: getComputedStyle(home).padding, dock: dock.getBoundingClientRect().height,
        labels: [...document.querySelectorAll('.neural-cluster-copy')].map(el => {
          const r = el.getBoundingClientRect(), text = el.querySelector('strong').getBoundingClientRect();
          return { left: r.left, right: r.right, bottom: r.bottom, top: r.top, textInside: text.left >= r.left && text.right <= r.right && text.top >= r.top && text.bottom <= r.bottom };
        }) };
    });
    assert.equal(metrics.padding, '0px', `${width}: measured dock must not include obsolete panel padding`);
    for (const label of metrics.labels) {
      assert.ok(label.textInside, `${width}: module name remains readable inside its label`);
      assert.ok(label.left >= 0 && label.right <= width && label.top >= 0, `${width}: label stays inside the window`);
      assert.ok(label.bottom < height - metrics.dock - 30, `${width}: labels stay clear of the input dock`);
    }
  }
});
