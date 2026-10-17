// Oversize photos are shrunk to a bounded copy for the model instead of being refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { prepareVisionInputs } from './visionInputs.js';

test('a photo over 20 MB reaches the model as a ≤4096 px copy', async () => {
  const side = 3000;
  const big = await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(big.length > 20 * 1024 * 1024, `fixture ${big.length}`);
  const [message] = await prepareVisionInputs([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big.toString('base64')}`, detail: 'high' } }] }]);
  const part = message.content.find(p => p.type === 'image_url');
  const sent = Buffer.from(part.image_url.url.split(',')[1], 'base64');
  const meta = await sharp(sent).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 4096);
  assert.ok(sent.length < big.length);
});
