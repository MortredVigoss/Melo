import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocLinks, markdownLinks } from './check-doc-links.js';

test('relative document links must resolve; URLs, anchors, machine paths, code and local evidence are skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melo-doc-links-'));
  try {
    await mkdir(join(root, 'docs/handoffs'), { recursive: true });
    await writeFile(join(root, 'docs/plan.md'), '# plan\n');
    await writeFile(join(root, 'docs/handoffs/history.md'), [
      '[plan](../plan.md#section) [web](https://example.com) [top](#top)',
      '[machine](</Users/someone/Documents/New project/HANDOFF.md>) [evidence](../../.tmp/run/receipt.json)',
      '`[not a link](missing-in-code.md)`',
      '```', '[fenced](missing-in-fence.md)', '```',
      '[missing](../gone.md) [spaced](<../plan.md>)',
    ].join('\n'));
    assert.equal(markdownLinks('a [x](y.md "title") b').at(0).target, 'y.md');
    const result = await checkDocLinks(['docs/handoffs/history.md', 'docs/deleted.md'], root);
    assert.deepEqual(result.broken, ['docs/handoffs/history.md:7 → ../gone.md']);
    assert.equal(result.links, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
