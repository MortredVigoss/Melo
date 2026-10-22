'use strict';
// Integration check against the already running upstream host and its real renderer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = process.env.MELO_PET_PROFILE || path.join(os.homedir(), 'Library/Application Support/melo-desktop-pet-dsh');
const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'dsh/dsh-pet/standalone-runtime.json'), 'utf8'));
const base = `http://127.0.0.1:${manifest.port}/dsh-pet-7340`;
async function request(route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-dsh-pet-token': manifest.token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(JSON.stringify({ route, status: response.status, result }));
  return result;
}
(async () => {
  const results = [];
  for (const skin of ['winter', 'main']) {
    await request('/melo-skin', { skin });
    await new Promise(resolve => setTimeout(resolve, 3500));
    const winterNames = process.env.WINTER_ACTIONS ? process.env.WINTER_ACTIONS.split(',') : ['点击回应-元气挥手', '原地左转奔跑', '小提琴演奏', '涮火锅', '舞狮头', '装点圣诞树', '工作状态-雀跃庆祝'];
    const names = skin === 'winter' ? winterNames : ['点击回应-元气挥手'];
    for (const name of names) {
      const accepted = await request(`/anim?pet=${skin}&surface=desktop`, { name });
      let receipt;
      for (let attempt = 0; attempt < 3; attempt++) {
        receipt = await request(`/playback/${accepted.playbackId}?wait=ended,failed,cancelled&timeout=10000`);
        if (receipt.matched) break;
      }
      const result = { skin, name, ...receipt };
      results.push(result);
      fs.writeFileSync(path.join(__dirname, process.env.NATIVE_PLAYBACK_REPORT || '../evidence/animation-v2-native-playback.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
      console.log(JSON.stringify(result));
    }
  }
  await request('/melo-skin', { skin: 'winter' });
  fs.writeFileSync(path.join(__dirname, process.env.NATIVE_PLAYBACK_REPORT || '../evidence/animation-v2-native-playback.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (results.some(result => result.status !== 'ended')) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
