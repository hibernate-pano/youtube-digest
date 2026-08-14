const fs = require('fs');
const lines = fs.readFileSync('background.js', 'utf8').split('\n');
// 1-based inclusive ranges
const cloudRanges = [
  [1450, 1854],  // notes + cloud sync + vocabulary (except extract)
  [1895, 2088],  // saveVocabulary..completeGithubLogin
];
const cloudLines = [];
cloudLines.push([
  '/**',
  ' * Cloud sync layer (GitHub account): notes + vocabulary + reviews.',
  ' * Loaded by background.js via importScripts AFTER settings.js. Relies on',
  ' * the global YTD_SETTINGS for the server base URL and session key; never',
  ' * touches AI code, so the AI-dependent vocabulary extractor stays in',
  ' * background.js.',
  ' */',
  '',
].join('\n'));
for (const [start, end] of cloudRanges) {
  for (let i = start; i <= end; i++) cloudLines.push(lines[i - 1]);
  cloudLines.push('');
}
fs.writeFileSync('cloud-sync.js', cloudLines.join('\n'));
const removed = new Set();
for (const [start, end] of cloudRanges) {
  for (let i = start; i <= end; i++) removed.add(i);
}
const kept = lines.filter((_, index) => !removed.has(index + 1));
fs.writeFileSync('background.js', kept.join('\n'));
console.log('cloud-sync.js lines:', cloudLines.length);
console.log('background.js now:', kept.length, 'lines');