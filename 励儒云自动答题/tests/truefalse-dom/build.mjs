import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', '..', 'userscripts', 'moodle-quiz-solver.user.js');
const src = fs.readFileSync(srcPath, 'utf8');

const startMark = '  function norm(s) {';
const endMark = '  /* ==================== 五、页面识别与导航 ====================== */';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
if (start < 0 || end < 0 || end <= start) throw new Error('markers not found');

const block = src.slice(start, end);

function extractFunction(name) {
  const s = src.indexOf('  function ' + name + '(');
  if (s < 0) throw new Error('function not found: ' + name);
  const brace = src.indexOf('{', s);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(s, i + 1);
    }
  }
  throw new Error('unbalanced function: ' + name);
}
const reviewFn = extractFunction('reviewQuestions');

const head = `
const CFG = { delayMs: 0, batch: 5, promptExtra: '' };
const LS = { cache: 'qa_test_cache' };
function warn(...a) { (globalThis.__warns = globalThis.__warns || []).push(a.map(String).join(' ')); }
function log() {}
function cacheAnswer() {}
function cachedAnswer() { return null; }
`;

const tail = `
${reviewFn}
globalThis.__qa = {
  scrapeQuestions, applyAnswer, resolveAnswer, rawToTexts,
  trialAnswer, deterministicAnswer, tfCanonical, optEq, optionLabel,
  reviewQuestions,
};
`;

const outPath = path.join(here, 'qa-bundle.js');
fs.writeFileSync(outPath, head + '\n' + block + '\n' + tail, 'utf8');
console.log('wrote', outPath, (head + block + tail).length, 'chars');
