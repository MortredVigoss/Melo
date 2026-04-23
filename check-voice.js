try {
  const o = require('@discordjs/opus');
  console.log('[opus] ok, keys:', Object.keys(o));
} catch (e) {
  console.log('[opus] FAIL:', e.message);
}
try {
  const { generateDependencyReport } = require('@discordjs/voice');
  console.log('---');
  console.log(generateDependencyReport());
} catch (e) {
  console.log('[voice] FAIL:', e.message);
}
