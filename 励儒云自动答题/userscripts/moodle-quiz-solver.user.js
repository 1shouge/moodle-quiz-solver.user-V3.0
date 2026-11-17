// ==UserScript==
// @name         Moodle 通用 · 答题助手（错题本 + 满分冲刺）
// @namespace    https://moodle.scnu.edu.cn/
// @version      3.0.2
// @description  Moodle 测验自动作答：记录错题文字（选项会打乱也能用）→ 自动重考 → 直到满分。含「放任自流」（不自动交卷）和「满分冲刺」（自动交卷并重考）两种模式。
// @author       DSH / 二次修改
// @match        https://*/*
// @match        http://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * ===========================================================================
 * 答题助手 v3.0.2 —— 错题本 + 满分冲刺
 * ===========================================================================
 *
 * 和 v2.1.0 的区别（都是实测出来的）：
 *
 *   1. 新增错题本：按【题目文字 + 选项文字】记录，不按 ABCD。
 *      Moodle 每次重考会打乱选项顺序，按字母记必然错位。
 *
 *   2. 新增「满分冲刺」：交卷 → 回顾页学习错题 → 自动重考 → 直到满分。
 *      这是用户明确要求的模式；会在开始前 confirm() 提示不可逆。
 *
 *   3. 修复 v2.1.0 的多选致命 bug：
 *      v2 先 `checked = true` 再 `dispatchEvent('click')`，
 *      checkbox 会被再切换一次，变回未选。v3 只设置 checked，不点。
 *
 *   4. 修复 v2.1.0 的提交方式：
 *      本校主题会在 change 时自动保存并刷新，v3 不触发 change；
 *      翻页用 form.submit() + 临时 hidden[name=next]，
 *      不点按钮，避免 Moodle 的 JS 把刚填的答案冲掉。
 *
 *   5. 修复提交按钮文案：本校是「全部提交并结束」，不是
 *      v2 里写的「提交所有答案并结束」。v3 直接找
 *      form#frm-finishattempt，完全不依赖文案。
 *
 *   6. v3.0.1 修复判断题经常填不上：
 *      Moodle 4.x 判断题的 <label> 自带 class="ms-1"，
 *      旧代码清理图标时把 .ms-1 整个删掉，选项文字变成空字符串。
 *      现在只删 i/.icon；并且判断题支持「对/正确/True/T」语义互认，
 *      即使主题把选项包了多层也能抓到。
 *
 *   7. v3.0.2 修复「correct is not defined」：
 *      判断题重构时把多选分支里的 correct 集合改名成 correctList，
 *      漏改了一处；多选题会直接抛错停机。已修正并加回归测试。
 *
 * ---------------------------------------------------------------------------
 * 安全边界
 * ---------------------------------------------------------------------------
 *   - 「放任自流」：和 v2 一样，**绝不自动交卷**，到提交页停下。
 *   - 「满分冲刺」：会**自动交卷并自动重考**，只在用户点按钮 + confirm 后
 *     才启动；到达 maxRounds、读不到成绩、提示次数用完时立刻停机。
 *   - 不伪造分数、不改服务端数据；只操作当前已经打开的页面表单。
 *
 * ===========================================================================
 */

(function () {
  'use strict';

  /* ============================ 常量 ============================ */
  const LS = {
    cfg: 'scnu_quiz_ai_cfg_v2',
    cfgLegacy: 'scnu_quiz_ai_cfg_v1',
    cache: 'scnu_quiz_ai_cache_v2',
    run: 'scnu_quiz_run_v2',
    book: 'scnu_quiz_wrongbook_v1',
  };
  const CACHE_MAX = 500;
  const BOOK_MAX = 800;
  const MAX_PAGES_PER_ATTEMPT = 60;
  const MAX_ASKS_PER_ATTEMPT = 80;

  const NEXT_TEXTS = [
    '下一页', '下一步', '下一题', '下一頁', '下一題',
    'Next page', 'Next', 'Next question', 'Continue',
    '次のページ', '次へ', '다음 페이지', 'Weiter', 'Suivant',
  ];
  const FINISH_TEXTS = [
    '全部提交并结束', '提交所有答案并结束', '结束答题', '提交并结束', '交卷',
    '提交所有答案並結束', '結束答題', '全部提交並結束',
    'Submit all and finish', 'Finish attempt', 'Submit all',
    'すべての解答を送信して終了', '모든 답안 제출하고 종료',
    'Alles absenden und beenden', 'Terminer',
  ];
  const START_TEXTS = [
    '开始答题', '开始作答', '开始测验', '继续作答',
    'Start attempt', 'Attempt quiz now', 'Continue your attempt',
    '開始作答', '開始測驗',
  ];
  const REATTEMPT_TEXTS = [
    '重新作答', '再答一次', '再次作答', '重考',
    'Re-attempt', 'Reattempt', 'Attempt again', 'Try again',
    '再受験', '다시 시도',
  ];

  const log = (...a) => console.log('%c[答题助手v3]', 'color:#7c3aed;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[答题助手v3]', 'color:#e8590c;font-weight:bold', ...a);

  /* ============================ 配置 ============================ */
  const DEFAULT_CFG = {
    provider: 'direct',
    bridgeUrl: 'http://127.0.0.1:19387/scnu-bridge/ask',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0,
    maxTokens: 3000,
    batch: 5,
    delayMs: 600,
    promptExtra: '',
    keepGoingOnFailure: true,
    settleMs: 1200,
    maxRounds: 8,
  };

  let CFG = loadCfg();

  function loadCfg() {
    try {
      const read = (k) => (typeof GM_getValue === 'function')
        ? GM_getValue(k, '') : localStorage.getItem(k);
      let raw = read(LS.cfg);
      if (!raw) raw = read(LS.cfgLegacy); // 兼容 v2 的配置
      return Object.assign({}, DEFAULT_CFG, JSON.parse(raw || '{}'));
    } catch (e) {
      return Object.assign({}, DEFAULT_CFG);
    }
  }

  function saveCfg(cfg) {
    const raw = JSON.stringify(cfg);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(LS.cfg, raw);
      else localStorage.setItem(LS.cfg, raw);
    } catch (e) { /* ignore */ }
  }

  /* ======================= 跨页面运行状态 ========================= */
  function readRun() {
    try {
      const r = JSON.parse(localStorage.getItem(LS.run) || '{}');
      return {
        armed: r.armed === true,
        mode: r.mode === 'perfect' ? 'perfect' : (r.mode === 'single' ? 'single' : null),
        cmid: r.cmid || null,
        attempt: r.attempt || null,
        round: Number(r.round) || 0,
        maxRounds: Number(r.maxRounds) || Number(CFG.maxRounds) || 8,
        processed: Array.isArray(r.processed) ? r.processed : [],
        pages: Number(r.pages) || 0,
        asked: Number(r.asked) || 0,
        submits: Number(r.submits) || 0,
        phase: r.phase || null,
        lastScore: r.lastScore || null,
        lastReviewAttempt: r.lastReviewAttempt || null,
        scanned: r.scanned === true,
        startedAt: r.startedAt || null,
      };
    } catch (e) {
      return {
        armed: false, mode: null, cmid: null, attempt: null, round: 0,
        maxRounds: CFG.maxRounds, processed: [], pages: 0, asked: 0, submits: 0,
        phase: null, lastScore: null, lastReviewAttempt: null,
        scanned: false, startedAt: null,
      };
    }
  }

  function writeRun(run) {
    try { localStorage.setItem(LS.run, JSON.stringify(run)); } catch (e) { /* ignore */ }
  }

  function disarm() {
    const run = readRun();
    run.armed = false;
    writeRun(run);
  }

  /* ========================= 错题本 ============================== */
  function loadBook() {
    try { return JSON.parse(localStorage.getItem(LS.book) || '{}'); }
    catch (e) { return {}; }
  }

  function saveBook(book) {
    try {
      const keys = Object.keys(book);
      if (keys.length > BOOK_MAX) {
        keys.sort((a, b) => (book[a].updatedAt || 0) - (book[b].updatedAt || 0));
        keys.slice(0, keys.length - BOOK_MAX).forEach(k => { delete book[k]; });
      }
      localStorage.setItem(LS.book, JSON.stringify(book));
    } catch (e) { /* ignore */ }
  }

  /** 题目文字归一化：只用来做 key / 比对，不用于显示 */
  function norm(s) {
    return String(s || '')
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[（）()【】\[\]{}《》<>“”"'‘’]/g, '')
      .replace(/[，,。.、；;：:！!？?·—–\-_/\\|]/g, '')
      .toLowerCase();
  }

  /**
   * 判断题选项的语义归一。
   * 本校/不同主题可能显示「对/错」「正确/错误」「True/False」，
   * 模型也可能返回其中任意一种，必须按语义而不是按字面匹配。
   */
  function tfCanonical(label) {
    const s = norm(stripPrefix(label));
    if (!s) return null;
    if (/^(对|正确|是|真|true|t|yes|y|√|✓)$/.test(s)) return 'true';
    if (/^(错|错误|否|假|false|f|no|n|×|✗|x)$/.test(s)) return 'false';
    return null;
  }

  /** 判断两个选项文字是不是同一个选项（判断题按语义比对） */
  function optEq(q, a, b) {
    if (norm(a) === norm(b)) return true;
    if (q && q.type === 'truefalse') {
      const ka = tfCanonical(a);
      const kb = tfCanonical(b);
      if (ka && kb) return ka === kb;
    }
    return false;
  }

  function qKey(text, type) {
    return String(type || 'unknown') + '|' + norm(text).slice(0, 300);
  }

  function mergeUniq(arr, add) {
    const seen = new Set(arr.map(norm));
    (add || []).forEach(x => {
      const t = String(x || '').trim();
      if (!t) return;
      const n = norm(t);
      if (!n || seen.has(n)) return;
      seen.add(n);
      arr.push(t);
    });
    return arr;
  }

  function upsertBook(entry) {
    if (!entry || !entry.text) return null;
    const book = loadBook();
    const key = qKey(entry.text, entry.type);
    const rec = book[key] || {
      text: entry.text,
      type: entry.type || 'unknown',
      options: [],
      wrong: [],
      correct: [],
      hintMissing: false,
      lastState: '',
      updatedAt: 0,
    };

    mergeUniq(rec.options, entry.options);

    if (entry.authoritative) {
      // 整题正确的那次是权威数据：直接替换，避免旧的错误记忆互相打架
      rec.correct = [];
      rec.wrong = [];
      mergeUniq(rec.correct, entry.correct);
      mergeUniq(rec.wrong, entry.wrong);
      rec.hintMissing = false;
    } else {
      mergeUniq(rec.correct, entry.correct);
      mergeUniq(rec.wrong, entry.wrong);
      if (entry.hintMissing) rec.hintMissing = true;
    }

    // 冲突时以 correct 为准（判断题「对/正确」视为同一项）
    const qt = { type: rec.type };
    rec.wrong = rec.wrong.filter(x => !rec.correct.some(y => optEq(qt, x, y)));

    if (entry.lastState) rec.lastState = entry.lastState;
    rec.updatedAt = Date.now();
    book[key] = rec;
    saveBook(book);
    return rec;
  }

  function bookMemory(q) {
    const rec = loadBook()[qKey(q.text, q.type)];
    let wrong = (rec && rec.wrong) || [];
    let correct = (rec && rec.correct) || [];

    // 只保留当前题目确实存在的选项：题目/选项被老师改过时，旧记忆不能误伤新题。
    if (q.options && q.options.length) {
      correct = correct.filter(x => q.options.some(o => optEq(q, o.label, x)));
      wrong = wrong.filter(x => q.options.some(o => optEq(q, o.label, x)));
      // 全部选项都被记成"错误" ⇒ 这条记忆已经失效，整条忽略，交给模型重新判断。
      const wrongHits = q.options.filter(o => wrong.some(x => optEq(q, x, o.label))).length;
      if (wrongHits >= q.options.length) {
        warn('错题本与当前选项全部冲突，已忽略该题记忆:', String(q.text).slice(0, 40));
        wrong = [];
        correct = [];
      }
    }

    return {
      wrong,
      correct,
      hintMissing: !!(rec && rec.hintMissing),
      rec: rec || null,
    };
  }

  function bookStats() {
    const book = loadBook();
    const keys = Object.keys(book);
    let wrong = 0, correct = 0;
    keys.forEach(k => {
      wrong += (book[k].wrong || []).length;
      correct += (book[k].correct || []).length;
    });
    return { questions: keys.length, wrong, correct };
  }

  /* =========================== 工具 ============================== */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function txt(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 剥掉选项文本的字母前缀（"B. 历史唯物主义" → "历史唯物主义"） */
  function stripPrefix(label) {
    const s = String(label || '').trim();
    const m = s.match(/^[（(]?([A-Za-z])[)）.、．:：]\s*(.+)$/s);
    if (m && m[2]) return m[2].trim();
    return s.replace(/^[\s\-–—_]+/, '').trim();
  }

  function optionLabel(row) {
    const lbl = row.querySelector('[data-region="answer-label"]');
    if (lbl) {
      const num = lbl.querySelector('.answernumber');
      let t = txt(lbl);
      if (num) {
        const n = txt(num);
        if (n && t.startsWith(n)) t = t.slice(n.length);
      }
      const clean = stripPrefix(t);
      if (clean) return clean;
    }
    // 回顾页的 row 里可能还有 "正确/错误" 图标文字，尽量只取 label 部分。
    // 注意：判断题的 <label> 本身带 class="ms-1"（Moodle 4.x core），
    // 绝不能把 .ms-1 整块删掉，否则选项文字会变成空字符串 → 判断题填不上。
    const clone = row.cloneNode(true);
    clone.querySelectorAll('i, .icon').forEach(x => x.remove());
    return stripPrefix(txt(clone));
  }

  /**
   * 从 input 自身找标签文字。
   * 判断题在不同主题下结构不完全一样，有的 label 不在 div.answer > div 里，
   * 只靠 optionLabel(row) 会拿到空字符串 → 选项文字为空 → 最终填不上答案。
   */
  function inputLabel(q, inp) {
    if (!inp) return '';
    let lbl = null;
    if (inp.id) {
      try { lbl = q.querySelector('label[for="' + String(inp.id).replace(/"/g, '\\"') + '"]'); }
      catch (e) { lbl = null; }
    }
    if (!lbl && inp.closest) lbl = inp.closest('label');
    if (!lbl && inp.parentElement) lbl = inp.parentElement.querySelector('label');
    if (!lbl && inp.nextElementSibling && inp.nextElementSibling.tagName === 'LABEL') {
      lbl = inp.nextElementSibling;
    }
    let t = lbl ? optionLabel(lbl) : '';
    if (!t) {
      const row = (inp.closest && inp.closest('div, li, tr')) || inp.parentElement;
      const count = row ? row.querySelectorAll('input[type=radio], input[type=checkbox]').length : 0;
      if (row && count === 1) t = optionLabel(row);
    }
    return t;
  }

  /** 判断题连标签文字都取不到时，按 input 的 id / value 兜底成「对/错」 */
  function tfLabelFromInput(inp) {
    if (!inp) return '';
    const id = String(inp.id || '');
    // Moodle core 的 id 是 q123:1_answertrue / q123:1_answerfalse
    if (/true$/i.test(id)) return '对';
    if (/false$/i.test(id)) return '错';
    const v = String(inp.value);
    if (v === '1') return '对';
    if (v === '0') return '错';
    return '';
  }

  /* ========================= 一、抓题 ============================ */
  function scrapeQuestions() {
    const nodes = document.querySelectorAll('div.que');
    const out = [];

    nodes.forEach((q, i) => {
      const cls = q.className || '';
      const qtype = (cls.match(/\bque\s+([a-z0-9_]+)/) || [])[1] || 'unknown';
      const qtextEl = q.querySelector('.qtext');
      const text = txt(qtextEl) || ('（第 ' + (i + 1) + ' 题，取不到题干）');
      const qno = txt(q.querySelector('.qno')) || String(i + 1);

      let prefix = null;
      const anyInput = q.querySelector('input[name], textarea[name], select[name]');
      if (anyInput) {
        const m = (anyInput.getAttribute('name') || '').match(/^(q\d+:\d+)_/);
        if (m) prefix = m[1];
      }

      const item = {
        n: i + 1, qno, prefix, type: qtype, text,
        options: [], inputType: null, el: null,
        extraInputs: [], matchSelects: null, answered: false, minwords: 0,
      };

      /* --- 选择题 --- */
      if (qtype === 'multichoice' || qtype === 'truefalse' || qtype === 'multichoiceset') {
        const ans = q.querySelector('.ablock') || q;
        const oneChoiceInput = (row) =>
          row.querySelectorAll('input[type=radio], input[type=checkbox]').length === 1;
        let rows = Array.from(ans.querySelectorAll('div.answer > div')).filter(oneChoiceInput);
        if (!rows.length) {
          rows = Array.from(ans.querySelectorAll('div[class^="r"], div[class*=" r"]')).filter(oneChoiceInput);
        }

        const seen = new Set();
        const addOption = (inp, label) => {
          if (!inp || seen.has(inp)) return;
          seen.add(inp);
          const key = String.fromCharCode(65 + item.options.length);
          item.options.push({
            key,
            // 绝不让选项文字为空：空标签会让后面的试错/匹配全部失效
            label: label || ('选项' + key),
            value: inp.value,
            el: inp,
            checked: !!inp.checked,
          });
          if (!item.inputType) item.inputType = inp.type;
          if (inp.checked) item.answered = true;
        };

        rows.forEach(row => {
          const inp = row.querySelector('input[type=radio], input[type=checkbox]');
          let label = optionLabel(row);
          if (!label) label = inputLabel(q, inp);
          if (!label && qtype === 'truefalse') label = tfLabelFromInput(inp);
          addOption(inp, label);
        });

        // 有些主题的判断题把 input 放得很深，div.answer > div 一个都命不中。
        // 直接按题目内所有 radio/checkbox 兜底，保证判断题永远能拿到两个选项。
        if (!item.options.length) {
          Array.from(ans.querySelectorAll('input[type=radio], input[type=checkbox]'))
            .filter(inp => inp.type !== 'hidden' && !inp.disabled &&
              String(inp.value) !== '-1' && !/\bsr-only\b/.test(inp.className || ''))
            .forEach(inp => {
              let label = inputLabel(q, inp);
              if (!label && qtype === 'truefalse') label = tfLabelFromInput(inp);
              addOption(inp, label);
            });
        }

        if (qtype === 'truefalse' && item.options.length < 2) {
          warn('判断题选项没抓全:', String(text).slice(0, 40), item.options.map(o => o.label));
        }
      }
      /* --- 填空 / 数值 / 论述 --- */
      else if (qtype === 'shortanswer' || qtype === 'numerical' || qtype === 'essay') {
        const inp = q.querySelector('textarea, input[type=text]');
        item.inputType = inp ? (inp.tagName === 'TEXTAREA' ? 'textarea' : 'text') : null;
        item.el = inp || null;
        item.answered = !!(inp && inp.value && inp.value.trim());
        const all = txt(q);
        let mw = all.match(/不少于\s*(\d+)\s*(?:个)?\s*(?:词|字)/);
        if (!mw) mw = all.match(/(?:at least|minimum(?: of)?|not less than)\s*(\d+)\s*words?/i);
        if (!mw) mw = all.match(/(\d+)\s*words?\s*(?:or more|minimum)/i);
        if (mw) item.minwords = parseInt(mw[1], 10) || 0;
      }
      /* --- 匹配题：每个空是 select --- */
      else if (qtype === 'match' || qtype === 'ddmatch') {
        item.matchSelects = Array.from(q.querySelectorAll('select'));
        item.inputType = 'select';
      }
      /* --- 其它 --- */
      else {
        item.extraInputs = Array.from(q.querySelectorAll('input[type=text], textarea, select'));
        item.inputType = item.extraInputs.length ? 'multi' : null;
      }

      out.push(item);
    });

    return out;
  }

  /* ======================= 二、答案决策 ========================== */
  function deterministicAnswer(q, mem) {
    if (!q.options || !q.options.length) return null;
    const wrongList = mem.wrong || [];
    const correctList = mem.correct || [];

    const available = q.options.filter(o => !wrongList.some(x => optEq(q, x, o.label)));
    const known = available.filter(o => correctList.some(x => optEq(q, x, o.label)));

    if (q.type === 'multichoice' || q.type === 'truefalse') {
      if (known.length) return [known[0].label];
      if (available.length === 1) return [available[0].label];
      return null;
    }

    if (q.type === 'multichoiceset') {
      if (!available.length) return null;
      const unknown = available.filter(o => !correctList.some(x => optEq(q, x, o.label)));
      // 可选集合里已经没有未知项 ⇒ 已知正确项就是完整答案
      if (known.length && !unknown.length) return known.map(o => o.label);
      return null;
    }

    return null;
  }

  /**
   * 模型没给出答案时的「试错」兜底：
   * 只对选择题生效，挑一个错题本里还没试过（不在 wrong 里）的选项。
   * 单选/判断：优先已知正确项，否则试第一个可用项。
   * 多选：已知正确项必选，再补一个未知项；什么都不知道时先只试一个，
   *       下一轮回顾页会告诉脚本它对不对，避免一次全选。
   */
  function trialAnswer(q, mem) {
    if (!q.options || !q.options.length) return null;
    const wrongList = mem.wrong || [];
    const correctList = mem.correct || [];
    const available = q.options.filter(o => !wrongList.some(x => optEq(q, x, o.label)));
    if (!available.length) return null;

    if (q.type === 'multichoice' || q.type === 'truefalse') {
      const known = available.find(o => correctList.some(x => optEq(q, x, o.label)));
      return [known ? known.label : available[0].label];
    }

    if (q.type === 'multichoiceset') {
      const must = available.filter(o => correctList.some(x => optEq(q, x, o.label)));
      const unknown = available.filter(o => !correctList.some(x => optEq(q, x, o.label)));
      if (must.length) {
        return (unknown.length ? must.concat([unknown[0]]) : must).map(o => o.label);
      }
      return [available[0].label];
    }

    return null;
  }

  function buildPrompt(questions, memMap) {
    const TYPES = {
      multichoice: '单选题（只能选 1 个）',
      multichoiceset: '多选题（可选多个）',
      truefalse: '判断题',
      shortanswer: '填空题（给出填空内容，不要带引号）',
      numerical: '数值题（只给数字）',
      essay: '简答题（用 150~300 字作答）',
      match: '匹配题（按空位顺序给出答案文字）',
      ddmatch: '匹配题（按空位顺序给出答案文字）',
    };
    const lines = [];
    questions.forEach(q => {
      lines.push(`【第${q.n}题】(${TYPES[q.type] || ('题目类型：' + q.type)})`);
      lines.push(q.text);
      q.options.forEach(o => lines.push(`  ${o.key}. ${o.label}`));
      const mem = memMap[q.n] || { wrong: [], correct: [] };
      if (mem.wrong && mem.wrong.length) {
        lines.push('  系统记忆（已确认错误，绝不能选）：' + mem.wrong.join(' ｜ '));
      }
      if (mem.correct && mem.correct.length) {
        lines.push('  系统记忆（已确认正确，必须选）：' + mem.correct.join(' ｜ '));
      }
      if (mem.hintMissing) {
        lines.push('  系统记忆：上次作答被判错，但已选选项都正确，说明漏选了；请从剩余选项中补选。');
      }
      lines.push('');
    });

    const sys = [
      '你是一位严谨的学科答题助手。请根据题目和选项给出最可能正确的答案。',
      '要求：',
      '1. 只输出 JSON，不要任何解释、不要 markdown 代码围栏。',
      '2. 格式：{"answers":[{"n":题号,"answer":"答案"}]}',
      '3. 选择题 answer 用选项字母：单选 "B"，多选按字母升序连写 "ABD"。',
      '4. 判断题同样用字母（A/B）。',
      '5. 填空题 answer 直接给内容；数值题只给数字；简答题给一段完整作答文字。',
      '6. 若某题完全无法判断，answer 用空字符串 ""。',
      '7. 如果题目给出了“已确认错误/已确认正确”的系统记忆，必须严格遵守：',
      '   - 已确认错误的选项绝不能出现在答案里；',
      '   - 已确认正确的选项必须出现在多选答案里。',
      '8. 如果排除错误选项后只剩一个候选，直接选它，不要犹豫。',
      CFG.promptExtra ? ('补充信息：' + CFG.promptExtra) : '',
    ].filter(Boolean).join('\n');

    return { sys, user: lines.join('\n') };
  }

  function callBridge(user) {
    const url = String(CFG.bridgeUrl || '').trim();
    if (!url) return Promise.reject(new Error('没填本地桥地址'));
    const body = JSON.stringify({ questions: user, jsonMode: true });
    return new Promise((resolve, reject) => {
      const done = (text) => {
        try {
          const j = JSON.parse(text);
          if (j && j.ok === true) {
            resolve({ choices: [{ message: { content: String(j.content || '') } }], _bridge: true });
          } else reject(new Error((j && j.error) || '桥返回失败'));
        } catch (e) {
          reject(new Error('桥返回不是 JSON：' + String(text).slice(0, 300)));
        }
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers: { 'Content-Type': 'application/json' },
          data: body, timeout: 150000,
          onload: (r) => done(r.responseText),
          onerror: () => reject(new Error('连不上本地桥。请确认插件里 bridgeEnabled: true')),
          ontimeout: () => reject(new Error('本地桥超时')),
        });
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
          .then(async (r) => done(await r.text()))
          .catch((e) => reject(new Error('连不上本地桥（可能跨域被拦）：' + e.message)));
      }
    });
  }

  function chatCompletionsUrl() {
    const base = String(CFG.baseUrl || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
  }

  function callLLM(sys, user) {
    if (CFG.provider === 'bridge') return callBridge(user);

    const url = chatCompletionsUrl();
    const body = {
      model: CFG.model,
      temperature: Number(CFG.temperature) || 0,
      max_tokens: Number(CFG.maxTokens) || 3000,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    };

    const headers = { 'Content-Type': 'application/json' };
    if (CFG.apiKey) headers['Authorization'] = 'Bearer ' + CFG.apiKey;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers,
          data: JSON.stringify(body), timeout: 120000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) {
              try { resolve(JSON.parse(res.responseText)); }
              catch (e) { reject(new Error('接口返回不是 JSON: ' + res.responseText.slice(0, 300))); }
            } else {
              reject(new Error('HTTP ' + res.status + ' ' + String(res.responseText || '').slice(0, 300)));
            }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      });
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }).then(async r => {
      const t = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
      return JSON.parse(t);
    });
  }

  function parseAnswers(respText) {
    let s = String(respText || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    const map = {};

    const put = (n, ans) => {
      const num = parseInt(n, 10);
      if (Number.isFinite(num)) map[num] = ans;
    };

    if (Array.isArray(obj)) {
      obj.forEach(x => put(x.n !== undefined ? x.n : x.index, x.answer));
    } else if (obj && Array.isArray(obj.answers)) {
      obj.answers.forEach(x => put(x.n !== undefined ? x.n : x.index, x.answer));
    } else if (obj && Array.isArray(obj.result)) {
      obj.result.forEach(x => put(x.n !== undefined ? x.n : x.index, x.answer));
    } else if (obj && obj.answers && typeof obj.answers === 'object') {
      Object.keys(obj.answers).forEach(k => put(k, obj.answers[k]));
    }
    return map;
  }

  /** 把模型返回的字母/文字解析成当前页面的选项文字数组 */
  function rawToTexts(q, raw) {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) {
      return raw.map(x => String(x).trim()).filter(Boolean)
        .map(x => resolveOne(q, x)).filter(Boolean);
    }

    let s = String(raw).trim();
    if (!s) return [];
    s = s.replace(/^(答案是|正确答案是|判断|答案[:：]|正确答案[:：]|answer[:：]?)/i, '').trim();
    s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    s = s.replace(/[。．.、,，;；:：\s]+$/g, '').trim();

    const opts = q.options || [];
    if (!opts.length) return [s];

    // 判断题：模型可能回「对/错」「正确/错误」「True/False」「T/F」，
    // 先按语义找选项，避免因为字面不同而白白空着。
    if (q.type === 'truefalse') {
      const canon = tfCanonical(s);
      if (canon) {
        const o = opts.find(x => tfCanonical(x.label) === canon);
        if (o) return [o.label];
      }
    }

    // 纯字母（单选 "B" / 多选 "ABD"）
    const upper = s.toUpperCase();
    const letters = upper.match(/^[A-Z](?:[\s,，、]*[A-Z])*$/);
    if (letters && upper.replace(/[^A-Z]/g, '').length <= opts.length) {
      const keys = upper.replace(/[^A-Z]/g, '').split('');
      const out = keys.map(k => {
        const o = opts.find(x => x.key === k);
        return o ? o.label : null;
      }).filter(Boolean);
      if (out.length) return out;
    }

    // 文字：先按分隔符拆，再逐项匹配
    const parts = s.split(/[;；,，\n]/).map(x => x.trim()).filter(Boolean);
    const out = [];
    const push = (label) => {
      if (label && !out.some(x => norm(x) === norm(label))) out.push(label);
    };
    parts.forEach(p => {
      const r = resolveOne(q, p);
      if (r) push(r);
    });
    if (!out.length) {
      // 整段里包含某选项文字
      opts.forEach(o => {
        if (o.label && s.includes(o.label)) push(o.label);
      });
    }
    return out;
  }

  function resolveOne(q, s) {
    const t = String(s || '').trim();
    if (!t) return null;
    const n = norm(stripPrefix(t));
    if (!n) return null;
    const opts = q.options || [];

    // 判断题先按语义匹配（对/正确/True/T ↔ 错/错误/False/F）
    if (q.type === 'truefalse') {
      const canon = tfCanonical(t);
      if (canon) {
        const c = opts.find(x => tfCanonical(x.label) === canon);
        if (c) return c.label;
      }
    }

    let o = opts.find(x => optEq(q, x.label, t));
    if (o) return o.label;
    // 单个字母（模型在数组里返回 ["A"] 的情况）
    if (q.options && q.options.length && /^[A-Za-z]$/.test(t)) {
      o = opts.find(x => x.key === t.toUpperCase());
      if (o) return o.label;
    }
    o = opts.find(x => norm(x.label).includes(n) || n.includes(norm(x.label)));
    if (o && Math.min(norm(o.label).length, n.length) >= 2) return o.label;
    return null;
  }

  function resolveAnswer(q, raw, mem) {
    const wrongList = mem.wrong || [];
    const isWrong = (x) => wrongList.some(w => optEq(q, w, x));
    const must = (mem.correct || []).filter(x => {
      return q.options.some(o => optEq(q, o.label, x));
    });
    let texts = rawToTexts(q, raw).filter(x => !isWrong(x));

    if (q.type === 'multichoice' || q.type === 'truefalse') {
      if (!texts.length) return deterministicAnswer(q, mem);
      if (must.length) {
        const m = q.options.find(o => optEq(q, o.label, must[0]));
        if (m && !isWrong(m.label)) return [m.label];
      }
      return [texts[0]];
    }

    if (q.type === 'multichoiceset') {
      const out = [];
      must.forEach(x => {
        const o = q.options.find(y => optEq(q, y.label, x));
        if (o && !isWrong(o.label) && !out.some(z => optEq(q, z, o.label))) out.push(o.label);
      });
      texts.forEach(x => {
        if (!out.some(z => optEq(q, z, x))) out.push(x);
      });
      return out.length ? out : deterministicAnswer(q, mem);
    }

    // 非选择题：原样返回
    return texts.length ? [texts[0]] : (String(raw || '').trim() ? [String(raw).trim()] : []);
  }

  /* ========================= 答案缓存 ============================ */
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(LS.cache) || '{}'); }
    catch (e) { return {}; }
  }

  function saveCache(c) {
    try {
      const keys = Object.keys(c);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
        keys.slice(0, keys.length - CACHE_MAX).forEach(k => { delete c[k]; });
      }
      localStorage.setItem(LS.cache, JSON.stringify(c));
    } catch (e) { /* ignore */ }
  }

  function cachedAnswer(q) {
    const c = loadCache()[qKey(q.text, q.type)];
    if (!c || !Array.isArray(c.texts)) return null;
    if (!q.options || !q.options.length) return c.texts;
    const ok = c.texts.every(t => q.options.some(o => norm(o.label) === norm(t)));
    return ok ? c.texts : null;
  }

  function cacheAnswer(q, texts) {
    if (!texts || !texts.length) return;
    const c = loadCache();
    c[qKey(q.text, q.type)] = { texts: texts.slice(), at: Date.now() };
    saveCache(c);
  }

  /* ======================= 三、问模型 ============================ */
  async function solveQuestions(questions, onProgress) {
    const result = {};
    const memMap = {};
    const todo = [];
    const trials = [];

    questions.forEach(q => {
      const mem = bookMemory(q);
      memMap[q.n] = mem;

      const det = deterministicAnswer(q, mem);
      if (det && det.length) {
        result[q.n] = det;
        log(`第 ${q.n} 题由错题本直接确定: ${det.join(' / ')}`);
        return;
      }

      if (!q.options || !q.options.length) {
        const c = cachedAnswer(q);
        if (c && c.length) {
          result[q.n] = c;
          log(`第 ${q.n} 题命中缓存: ${c.join(' / ')}`);
          return;
        }
      }
      todo.push(q);
    });

    if (!todo.length) return { answers: result, asks: 0, trials };

    let asks = 0;
    const batch = Math.max(1, parseInt(CFG.batch, 10) || 5);
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      asks++;
      if (onProgress) {
        onProgress(`正在问模型：第 ${chunk[0].n}~${chunk[chunk.length - 1].n} 题（第 ${asks} 批）`);
      }
      const { sys, user } = buildPrompt(chunk, memMap);
      let content = '';
      try {
        const resp = await callLLM(sys, user);
        content = resp && resp.choices && resp.choices[0] &&
          resp.choices[0].message && resp.choices[0].message.content;
        if (!content && resp && typeof resp.content === 'string') content = resp.content;
      } catch (e) {
        warn('接口失败:', e.message);
        if (onProgress) onProgress('❌ 接口失败：' + e.message);
        chunk.forEach(q => {
          const det = deterministicAnswer(q, memMap[q.n]);
          result[q.n] = det && det.length ? det : null;
        });
        await sleep(CFG.delayMs);
        continue;
      }

      let map = {};
      try {
        map = parseAnswers(content);
      } catch (e) {
        warn('解析模型输出失败:', String(content).slice(0, 400));
        if (onProgress) onProgress('⚠ 模型输出不是合法 JSON，该批改用排除法');
      }

      chunk.forEach(q => {
        const raw = map[q.n];
        const resolved = resolveAnswer(q, raw, memMap[q.n]);
        if (resolved && resolved.length) {
          result[q.n] = resolved;
          if (q.options && q.options.length) cacheAnswer(q, resolved);
        } else {
          result[q.n] = deterministicAnswer(q, memMap[q.n]);
        }
      });
      await sleep(CFG.delayMs);
    }

    // 模型没给答案（接口失败 / 空回复 / 解析不出该题）时，选择题不要空着：
    // 用错题本里还没试过的选项试错，回顾页会告诉我们它对不对。
    questions.forEach(q => {
      const cur = result[q.n];
      if (cur && cur.length) return;
      if (!q.options || !q.options.length) return;
      const t = trialAnswer(q, memMap[q.n]);
      if (t && t.length) {
        result[q.n] = t;
        trials.push(q.n);
        log(`第 ${q.n} 题模型没给答案，试错选择: ${t.join(' / ')}`);
      }
    });

    return { answers: result, asks, trials };
  }

  /* ======================= 四、填答案 ============================ */
  function applyAnswer(q, answer) {
    const texts = Array.isArray(answer) ? answer.filter(Boolean) : (answer ? [String(answer)] : []);
    if (!texts.length) return { ok: false, why: '没有可用答案' };

    /* --- 选择题 --- */
    if (q.options && q.options.length) {
      const wanted = [];
      texts.forEach(t => {
        let o = q.options.find(x => optEq(q, x.label, t));
        // 判断题/选择题都可能收到 "A" / "B" 这种字母
        if (!o && /^[A-Za-z]$/.test(String(t).trim())) {
          o = q.options.find(x => x.key === String(t).trim().toUpperCase());
        }
        if (!o && q.type === 'truefalse') {
          const canon = tfCanonical(t);
          if (canon) o = q.options.find(x => tfCanonical(x.label) === canon);
        }
        if (o && !wanted.includes(o)) wanted.push(o);
      });
      if (!wanted.length) {
        return {
          ok: false,
          why: '答案文字没有匹配到任何选项：' + texts.join(' / ').slice(0, 40) +
            '；当前选项：' + q.options.map(o => o.label).join(' / ').slice(0, 80),
        };
      }

      let hit = 0;
      q.options.forEach(o => {
        if (!o.el) return;
        const want = wanted.includes(o);
        // 关键：只设置 checked，不 dispatch click/change。
        // 本校 Moodle 会在 change 时自动保存并刷新；click 会把 checkbox 再切回去。
        if (o.el.checked !== want) o.el.checked = want;
        if (want && o.el.checked) hit++;
      });
      const missed = wanted.filter(o => !o.el || !o.el.checked);
      if (missed.length) {
        return {
          ok: false,
          why: '已尝试选择，但这些选项没有勾上：' + missed.map(o => o.label).join(' / ').slice(0, 60),
        };
      }
      return { ok: hit > 0, why: '已选 ' + wanted.map(o => o.key).join('') };
    }

    /* --- 匹配题 --- */
    if (q.inputType === 'select' && q.matchSelects && q.matchSelects.length) {
      const parts = texts.join(';').split(/[;；,，\n]/).map(s => s.trim()).filter(Boolean);
      let hit = 0;
      q.matchSelects.forEach((sel, i) => {
        const want = parts[i] || parts[0] || '';
        const opts = Array.from(sel.options);
        const found = opts.find(o => txt(o) === want) ||
          opts.find(o => want && txt(o).includes(want)) ||
          opts.find(o => txt(o) && want.includes(txt(o)));
        if (found) { sel.value = found.value; hit++; }
      });
      return { ok: hit > 0, why: hit ? `匹配 ${hit} 个空` : '没匹配到选项文本' };
    }

    /* --- 填空/数值/论述 --- */
    const el = q.el || (q.extraInputs && q.extraInputs[0]);
    if (el) {
      const a = texts[0];
      const v = (q.type === 'numerical') ? a.replace(/[^\d.\-]/g, '') : a;
      el.value = v;
      if (q.minwords && v.replace(/\s/g, '').length < q.minwords) {
        return { ok: true, why: `已填入，但 ${v.length} 字 < 要求 ${q.minwords} 字（可能判未达标）` };
      }
      return { ok: true, why: '已填入' };
    }

    /* --- 多空 --- */
    if (q.extraInputs && q.extraInputs.length > 1) {
      q.extraInputs.forEach((inp, i) => {
        inp.value = texts[i] !== undefined ? texts[i] : texts[0];
      });
      return { ok: true, why: '已填多空' };
    }

    return { ok: false, why: '不支持的题型：' + q.type };
  }

  /* ==================== 五、页面识别与导航 ====================== */
  const isQuiz = () => /\/mod\/quiz\//.test(location.pathname);
  const isAttempt = () => /\/mod\/quiz\/attempt\.php/.test(location.pathname);
  const isReview = () => /\/mod\/quiz\/review\.php/.test(location.pathname);
  const isSummary = () => /\/mod\/quiz\/summary\.php/.test(location.pathname) ||
    (isAttempt() && !!document.getElementById('frm-finishattempt'));
  const isView = () => /\/mod\/quiz\/view\.php/.test(location.pathname);
  const isStartConfirm = () => {
    // 注意：入口页 view.php 里也有一个隐藏的 #id_submitbutton
    // （Moodle 的 preflight 弹窗），必须要求它真的可见，否则会把入口页
    // 误判成「开始答题」确认页，导致满分冲刺什么都不做。
    const b = document.getElementById('id_submitbutton');
    return !!b && visible(b);
  };

  function cmid() {
    const u = new URLSearchParams(location.search);
    return u.get('cmid') || u.get('id') || null;
  }

  function viewUrl(id) {
    return location.origin + '/mod/quiz/view.php?id=' + encodeURIComponent(id || cmid() || '');
  }

  /** 回顾页有时只有 review.php?attempt=...&cmid=...，保底从面包屑链接里再找一次 */
  function ensureCmid(run) {
    // 当前 URL 上的 cmid 最可信（review.php?attempt=...&cmid=...）
    const fromUrl = cmid();
    if (fromUrl) {
      run.cmid = fromUrl;
      return run.cmid;
    }
    if (run.cmid) return run.cmid;
    // 兜底：找指向本测验入口的链接。优先带 cmid 的，避免抓到隔壁活动。
    const links = Array.from(document.querySelectorAll('a[href*="view.php?id="]'));
    const a = links.find(x => /cmid=/.test(x.href || '')) || links[0];
    if (a) {
      const m = (a.href || '').match(/[?&]id=(\d+)/);
      if (m) run.cmid = m[1];
    }
    return run.cmid;
  }

  function attemptId() {
    const u = new URLSearchParams(location.search);
    return u.get('attempt') || u.get('cmid') || 'na';
  }

  function pageSig() {
    return location.pathname + location.search;
  }

  function pageNo() {
    return new URLSearchParams(location.search).get('page');
  }

  function visible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.type === 'hidden') return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function findSubmitButton(texts, names) {
    for (const n of names) {
      const els = document.querySelectorAll(
        `input[type=submit][name="${n}"], button[name="${n}"]`);
      for (const el of els) {
        if (visible(el)) return el;
      }
    }
    const all = document.querySelectorAll('input[type=submit], button[type=submit], button');
    for (const el of all) {
      if (!visible(el)) continue;
      const v = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!v) continue;
      if (texts.some(t => v === t || v.startsWith(t) || v.includes(t))) return el;
    }
    return null;
  }

  function findNextButton() {
    const direct = document.querySelector('input#mod_quiz-next-nav[name=next], input[name=next]');
    if (visible(direct)) return direct;
    return findSubmitButton(NEXT_TEXTS, ['next']);
  }

  function findPrevButton() {
    const direct = document.querySelector('input#mod_quiz-prev-nav[name=previous], input[name=previous]');
    if (visible(direct)) return direct;
    return findSubmitButton(['上一页', 'Previous'], ['previous']);
  }

  function findFinishForm() {
    const f = document.getElementById('frm-finishattempt');
    if (f) return f;
    const all = document.querySelectorAll('form');
    for (const x of all) {
      if (/processattempt\.php/.test(x.action || '') && x.querySelector('input[name=finishattempt]')) return x;
    }
    return null;
  }

  function findFinishButton() {
    return findSubmitButton(FINISH_TEXTS, ['finishattempt', 'finish']);
  }

  function findReattemptForm() {
    const forms = Array.from(document.querySelectorAll('form'));
    return forms.find(f => /startattempt\.php/.test(f.action || '') &&
      !!f.querySelector('button[type=submit], input[type=submit]')) || null;
  }

  /**
   * 找「开始答题」。
   * 本校的入口页把 preflight 表单放在一个 YUI 弹窗里：
   * 点「重新作答测验」后弹窗才显示，弹窗里的 #id_submitbutton 才是真正的
   * 「开始答题」。所以这里要同时兼容：
   *   1. 独立的 startattempt.php 确认页；
   *   2. YUI / Bootstrap 弹窗里的提交按钮（可能没有 id）。
   */
  function findStartButton() {
    const direct = document.getElementById('id_submitbutton');
    if (visible(direct)) return direct;

    const scopes = document.querySelectorAll(
      '.moodle-dialogue, .modal.show, .modal-dialog, [role="dialog"]');
    for (const sc of scopes) {
      if (!visible(sc)) continue;
      const btns = sc.querySelectorAll(
        'input[type=submit], button[type=submit], button');
      for (const b of btns) {
        const v = (b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!v || /取消|cancel/i.test(v)) continue;
        if (START_TEXTS.some(t => v === t || v.includes(t))) return b;
      }
    }

    // 兜底：页面上任何可见的「开始答题」
    for (const b of document.querySelectorAll('input[type=submit], button[type=submit], button')) {
      if (!visible(b)) continue;
      const v = (b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (!v || /取消|cancel/i.test(v)) continue;
      if (START_TEXTS.some(t => v === t || v.includes(t))) return b;
    }
    return null;
  }

  /**
   * 点完「重新作答测验」后，等 preflight 弹窗出现，再点弹窗里的
   * 「开始答题」。Moodle 用 JS 拦截了重新作答按钮，不会立刻跳页，
   * 所以必须轮询，不能只点一次。
   */
  function waitAndClickStart(onFail) {
    const t0 = Date.now();
    const tick = () => {
      if (!readRun().armed) return;
      if (isAttempt()) return; // 已经跳到作答页
      const b = findStartButton();
      if (b) {
        log('点击「开始答题」:', b.value || b.textContent);
        setNow('已找到「开始答题」，正在开始…');
        b.click();
        return;
      }
      if (Date.now() - t0 < 15000) {
        setTimeout(tick, 350);
        return;
      }
      if (onFail) onFail();
    };
    tick();
  }

  function detectBlockers() {
    const patterns = [
      /会话\s*(已)?\s*(超时|过期|失效)/,
      /session\s+(has\s+)?(timed?\s*out|expired)/i,
      /(不允许|不能再|无法)\s*(再次)?\s*作答/,
      /(you (are|do) not have permission|not allowed to (attempt|continue))/i,
      /你没有权限/, /无法继续/, /cannot continue/i,
      /已用完.{0,6}次/,
      /(the )?maximum number of attempts/i,
      /(没有|无)\s*剩余\s*(作答|尝试)\s*次数/, /已达到最大作答次数/,
      /no more attempts/i, /attempts? (are )?(no longer|not) (allowed|available)/i,
      /本测验已关闭/, /(quiz|this quiz) is (now )?closed/i,
    ];
    const text = (document.body && document.body.innerText || '').slice(0, 30000);
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[0];
    }
    return null;
  }

  /**
   * 直接提交 #responseform，而不是点「下一页」按钮。
   * form.submit() 不会带上按钮的 name=value，所以临时加一个 hidden。
   * 这样多选 checkbox 的状态一定按当前 DOM 提交，不会被主题的 autosave 冲掉。
   */
  function submitAttemptForm(which) {
    const f = document.getElementById('responseform') ||
      document.querySelector('form[action*="processattempt.php"]');
    if (!f) {
      warn('找不到 responseform');
      return false;
    }
    f.querySelectorAll('input[data-qa3-temp]').forEach(x => x.remove());
    const inp = document.createElement('input');
    inp.type = 'hidden';
    inp.name = which === 'previous' ? 'previous' : 'next';
    inp.value = '1';
    inp.setAttribute('data-qa3-temp', '1');
    f.appendChild(inp);
    log('提交作答表单:', inp.name, 'page=', pageNo(), 'nextpage=',
      (f.querySelector('input[name=nextpage]') || {}).value);
    f.submit();
    return true;
  }

  async function autoFinish() {
    const run = readRun();
    if (!run.armed) { log('已停止，不交卷'); return false; }

    // 兜底：即使状态机出岔子，一张卷子也不会被反复交超过 maxRounds+2 次
    if (run.submits > run.maxRounds + 2) {
      stopPerfect(`🛑 本次运行已自动交卷 ${run.submits} 次，超过保护上限，已停机。`, 'err');
      return false;
    }

    run.phase = 'submitting';
    run.submits = (Number(run.submits) || 0) + 1;
    writeRun(run);
    setNow('已到提交页，正在自动交卷…');

    const f = findFinishForm();
    if (f) {
      // 直接提交，绕过确认框；本模式是用户明确授权的。
      // 万一 direct submit 没跳转（个别主题/插件），2.5 秒后改成"点按钮 + 点确认"。
      setTimeout(() => {
        if (!isSummary()) return;
        if (!readRun().armed) return;
        const b = findFinishButton() || f.querySelector('button[type=submit], input[type=submit]');
        if (b) {
          b.click();
          setTimeout(() => {
            if (!readRun().armed) return;
            const ok = document.querySelector('.modal.show .modal-footer button[data-action="save"], .modal.show .modal-footer .btn-primary');
            if (ok) ok.click();
          }, 800);
        }
      }, 2500);
      log('直接提交 frm-finishattempt');
      f.submit();
      return true;
    }

    const btn = findFinishButton();
    if (btn) {
      log('点击提交按钮:', btn.value || btn.textContent);
      btn.click();
      await sleep(800);
      if (!readRun().armed) return false;
      const ok = document.querySelector('.modal.show .modal-footer button[data-action="save"], .modal.show .modal-footer .btn-primary');
      if (ok) {
        ok.click();
        return true;
      }
    }
    stopPerfect('没找到「全部提交并结束」按钮，已停手。', 'err');
    return false;
  }

  function startReattempt() {
    const f = findReattemptForm();
    if (f) {
      const b = f.querySelector('button[type=submit], input[type=submit]');
      if (b) {
        log('点击重新作答:', (b.value || b.textContent || '').trim());
        b.click();
        return true;
      }
    }
    const link = Array.from(document.querySelectorAll('a')).find(a =>
      /startattempt\.php|attempt\.php\?attempt=/.test(a.href || ''));
    if (link) {
      log('通过链接重新作答:', link.href);
      location.href = link.href;
      return true;
    }
    return false;
  }

  /* ==================== 六、回顾页学习 ========================== */
  function reviewQuestions(doc) {
    const nodes = doc.querySelectorAll('div.que');
    const out = [];
    nodes.forEach((q, i) => {
      const cls = q.className || '';
      const type = (cls.match(/\bque\s+([a-z0-9_]+)/) || [])[1] || 'unknown';
      const text = txt(q.querySelector('.qtext')) || ('（第 ' + (i + 1) + ' 题）');
      const state = txt(q.querySelector('.state'));
      const oneChoiceInput = (row) =>
        row.querySelectorAll('input[type=radio], input[type=checkbox]').length === 1;
      let rows = Array.from(q.querySelectorAll('div.answer > div')).filter(oneChoiceInput);
      // 回顾页有时没有 input（只渲染选项行），不能因为找不到 input 就把整题丢掉
      if (!rows.length) {
        rows = Array.from(q.querySelectorAll('div[class^="r"], div[class*=" r"]'))
          .filter(row => oneChoiceInput(row) ||
            row.querySelectorAll('input[type=radio], input[type=checkbox]').length === 0);
      }
      if (!rows.length) rows = Array.from(q.querySelectorAll('div.answer > div'));
      const opts = [];
      rows.forEach(row => {
        if (row.querySelector('input[type=hidden]') && !row.querySelector('input[type=radio], input[type=checkbox]')) return;
        const inp = row.querySelector('input[type=radio], input[type=checkbox]');
        let label = optionLabel(row);
        if (!label) label = inputLabel(q, inp);
        if (!label && type === 'truefalse') label = tfLabelFromInput(inp);
        if (!label) return;
        // 没有 input 时，判断题仍可从行 class 推断「选中的错项」
        let checked = inp ? !!inp.checked : false;
        if (!inp && type === 'truefalse') {
          if (/\bincorrect\b/.test(row.className || '')) checked = true;
          else if (state === '正确' && /\bcorrect\b/.test(row.className || '')) checked = true;
        }
        opts.push({
          key: String.fromCharCode(65 + opts.length),
          label,
          checked,
          correct: /\bcorrect\b/.test(row.className || ''),
          incorrect: /\bincorrect\b/.test(row.className || ''),
        });
      });
      const rightEl = q.querySelector('.rightanswer, .correctanswer, [data-region="right-answer"]');
      const rightText = rightEl ? txt(rightEl) : '';
      out.push({ n: i + 1, type, text, state, opts, rightText });
    });
    return out;
  }

  /** 有些主题会单独显示"正确答案"；尽力把它映射成选项文字 */
  function parseRightAnswer(q) {
    const t = String(q.rightText || '').replace(/^正确答案\s*[:：]?/, '').trim();
    if (!t || !q.opts.length) return [];
    const letters = t.toUpperCase().match(/^[A-Z](?:[\s,，、]*[A-Z])*$/);
    if (letters) {
      return t.toUpperCase().replace(/[^A-Z]/g, '').split('')
        .map(k => (q.opts.find(o => o.key === k) || {}).label)
        .filter(Boolean);
    }
    const out = [];
    q.opts.forEach(o => {
      const a = norm(o.label), b = norm(t);
      if (!a || !b) return;
      // 判断题按语义比对（正确答案可能是「对」，选项写「正确」）
      if (optEq(q, o.label, t)) { out.push(o.label); return; }
      // 只用足够长的包含关系做兜底，避免 "科学" 之类的短词误命中
      if (a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 4 && a.includes(b))) {
        out.push(o.label);
      }
    });
    return out;
  }

  function recordReviewDoc(doc, meta) {
    const qs = reviewQuestions(doc);
    if (!qs.length) return { questions: 0, learned: 0 };

    let learned = 0;
    qs.forEach(q => {
      const all = q.opts.map(o => o.label);
      const selected = q.opts.filter(o => o.checked).map(o => o.label);
      const markedCorrect = q.opts.filter(o => o.correct).map(o => o.label);
      const markedWrong = q.opts.filter(o => o.incorrect).map(o => o.label);
      const explicitCorrect = parseRightAnswer(q);
      const state = q.state || '';
      const isFullCorrect = /^正确\s*$/.test(state) ||
        (state.includes('正确') && !state.includes('部分') && !state.includes('错误'));
      const isWrong = /错误|部分正确|未作答|不正确|incorrect/i.test(state) || !isFullCorrect;

      const entry = {
        text: q.text, type: q.type, options: all,
        wrong: [], correct: explicitCorrect.slice(),
        hintMissing: false, lastState: state, authoritative: false,
      };

      if (isFullCorrect) {
        // 整题正确 ⇒ 选中的就是完整正确答案，未选项全是错的
        if (selected.length) {
          entry.authoritative = true;
          entry.correct = selected.slice();
          entry.wrong = all.filter(x => !selected.some(y => optEq(q, y, x)));
        }
      } else if (isWrong) {
        if (q.type === 'multichoice' || q.type === 'truefalse') {
          // 单选错题：选中的那一项一定错
          entry.wrong = selected.slice();
          mergeUniq(entry.correct, markedCorrect);
        } else if (q.type === 'multichoiceset') {
          mergeUniq(entry.correct, markedCorrect);
          entry.wrong = markedWrong.slice();
          // 判错但所有已选项都正确 ⇒ 是漏选
          if (selected.length && selected.length < all.length &&
              markedCorrect.length === selected.length &&
              markedWrong.length === 0) {
            entry.hintMissing = true;
          }
        } else {
          // 其它题型：能标记就标记
          mergeUniq(entry.correct, markedCorrect);
          entry.wrong = markedWrong.slice();
        }
      }

      // 没有学到任何选项信息就不建记录，避免错题本里全是空条目
      if (!entry.wrong.length && !entry.correct.length && !entry.hintMissing) return;

      const rec = upsertBook(entry);
      if (rec) learned++;
    });

    log('回顾页学习完成', { attempt: meta && meta.attempt, questions: qs.length, learned });
    return { questions: qs.length, learned };
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  async function scanHistory(onProgress) {
    const links = Array.from(document.querySelectorAll('a[href*="review.php?attempt="]'))
      .map(a => a.href)
      .filter((v, i, arr) => v && arr.indexOf(v) === i);
    if (!links.length) return { scanned: 0, total: 0 };

    let scanned = 0;
    for (let i = 0; i < links.length && i < 30; i++) {
      if (onProgress) onProgress(`📚 学习历史错题 ${i + 1}/${Math.min(links.length, 30)}…`);
      try {
        const html = await fetchText(links[i]);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (doc.querySelector('div.que')) {
          recordReviewDoc(doc, { attempt: (links[i].match(/attempt=(\d+)/) || [])[1] });
          scanned++;
        }
      } catch (e) {
        warn('学习历史失败:', links[i], e.message);
      }
      await sleep(250);
    }
    return { scanned, total: links.length };
  }

  /* ========================= 成绩 ================================ */
  function parseScore(doc) {
    doc = doc || document;
    const table = doc.querySelector('table.quizreviewsummary') ||
      doc.querySelector('.quizreviewsummary');
    const text = table ? txt(table) : txt(doc.body).slice(0, 20000);
    let m = text.match(/成绩\s*([\d.]+)\s*\/\s*([\d.]+)/);
    if (!m) m = text.match(/([\d.]+)\s*\/\s*([\d.]+)\s*[（(]\s*(\d+)\s*[%％]/);
    if (!m) return null;
    const got = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    if (!Number.isFinite(got) || !Number.isFinite(max) || max <= 0) return null;
    return { got, max, pct: Math.round(got / max * 100), full: got >= max - 0.01 };
  }

  /* ======================= 七、界面 ============================== */
  const state = { busy: false, lastReport: [], lastBannerKind: null };

  function setNow(html) {
    const el = document.getElementById('qa3-now');
    if (el) el.innerHTML = html;
  }

  function setBanner(html, kind) {
    const el = document.getElementById('qa3-banner');
    if (!el) return;
    state.lastBannerKind = kind || 'idle';
    el.innerHTML = html;
    el.style.background = kind === 'run' ? 'rgba(34,197,94,.12)'
      : kind === 'stop' ? 'rgba(245,158,11,.14)'
      : kind === 'err' ? 'rgba(239,68,68,.14)'
      : kind === 'done' ? 'rgba(124,58,237,.12)' : '#f5f3ff';
    el.style.borderColor = kind === 'run' ? 'rgba(34,197,94,.45)'
      : kind === 'stop' ? 'rgba(245,158,11,.5)'
      : kind === 'err' ? 'rgba(239,68,68,.5)'
      : kind === 'done' ? 'rgba(124,58,237,.45)' : 'transparent';
  }

  function toast(msg, kind) {
    let t = document.getElementById('qa3-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qa3-toast';
      t.style.cssText = `position:fixed;left:16px;top:16px;z-index:2147483647;max-width:420px;
        padding:10px 14px;border-radius:9px;background:#1f2937;color:#fff;font-weight:600;
        font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);display:none;`;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = kind === 'warn' ? '#b42318' : (kind === 'ok' ? '#067647' : '#1f2937');
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.display = 'none'; }, 8000);
  }

  function renderReport(rows) {
    const box = document.getElementById('qa3-report');
    if (!box) return;
    box.innerHTML = rows.map(r =>
      `<div class="r"><b>${esc(r.qno)}</b> <span class="${r.ok && r.answer ? 'ok' : 'bad'}">${esc(r.answer || '—')}</span>` +
      ` <span class="t">${esc(r.text)}</span><br><span class="w">${esc(r.why)}</span></div>`).join('');
  }

  function renderBookBox() {
    const box = document.getElementById('qa3-bookbox');
    if (!box) return;
    const book = loadBook();
    const keys = Object.keys(book);
    if (!keys.length) {
      box.innerHTML = '<div class="tip">错题本还是空的。答完一次后，点「📚 学习历史错题」或在回顾页停留即可记录。</div>';
      return;
    }
    keys.sort((a, b) => (book[b].updatedAt || 0) - (book[a].updatedAt || 0));
    box.innerHTML = keys.map(k => {
      const r = book[k];
      return `<div class="bk">
        <div class="q">${esc(String(r.text || '').slice(0, 120))}</div>
        <div class="m">类型：${esc(r.type)} · 状态：${esc(r.lastState || '—')}</div>
        <div class="wrong">✗ 已知错误：${r.wrong && r.wrong.length ? esc(r.wrong.join(' ｜ ')) : '—'}</div>
        <div class="correct">✓ 已知正确：${r.correct && r.correct.length ? esc(r.correct.join(' ｜ ')) : '—'}</div>
      </div>`;
    }).join('');
  }

  function paintStatus() {
    const run = readRun();
    const st = bookStats();
    const bookEl = document.getElementById('qa3-bookstat');
    if (bookEl) {
      bookEl.textContent = `📕 错题本：${st.questions} 题 · 已知错选项 ${st.wrong} · 已知正确 ${st.correct}`;
    }

    // 停机/报错/满分的横幅优先保留，不被普通的“尚未授权”覆盖
    const keepBanner = !run.armed &&
      (state.lastBannerKind === 'stop' || state.lastBannerKind === 'err' || state.lastBannerKind === 'done');

    if (!keepBanner) {
      if (run.armed && run.mode === 'perfect') {
        setBanner(`🟢 <b>满分冲刺进行中</b> · 第 <b>${run.round}/${run.maxRounds}</b> 轮<br>`
          + `已处理 ${run.pages} 页 · 已请求模型 ${run.asked} 批`
          + (run.lastScore ? ` · 上次 <b>${run.lastScore.got}/${run.lastScore.max}</b>` : ''), 'run');
      } else if (run.armed) {
        setBanner(`🟢 <b>放任自流已开启</b> · 已处理 ${run.pages} 页 / 已请求模型 ${run.asked} 批<br>`
          + `脚本会一直往下答，直到提交页停下。`, 'run');
      } else if (run.mode === 'perfect' && run.lastScore && run.lastScore.full) {
        setBanner(`🎉 <b>已满分</b> · ${run.lastScore.got}/${run.lastScore.max}<br>错题本已保存。`, 'done');
      } else {
        setBanner('⚪ 尚未授权 —— 点「🚀 放任自流」（不自动交卷）或「🏁 满分冲刺」（自动交卷+重考）。', 'idle');
      }
    }

    const lock = document.getElementById('qa3-lock');
    if (lock) {
      lock.textContent = run.armed
        ? '状态存在 localStorage，刷新/翻页不会丢。'
        : (st.questions ? '错题本存在 localStorage，换 attempt 也不会丢。' : '');
    }
  }

  function buildPanel() {
    if (document.getElementById('qa3-panel')) return;
    const el = document.createElement('div');
    el.id = 'qa3-panel';
    el.innerHTML = `
      <style>
        #qa3-panel{position:fixed;left:16px;bottom:16px;z-index:2147483646;width:392px;max-height:88vh;
          display:flex;flex-direction:column;
          font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1f2937;background:#fff;
          border:1px solid #d7dde6;border-radius:12px;box-shadow:0 8px 28px rgba(16,24,40,.2);overflow:hidden}
        #qa3-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;
          background:linear-gradient(90deg,#7c3aed,#a78bfa);color:#fff;cursor:move;font-weight:600;font-size:13px}
        #qa3-panel .hd span.mi{cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
        #qa3-panel .bd{padding:10px 12px;overflow:auto}
        #qa3-panel label{display:block;font-size:11px;color:#475569;margin:6px 0 2px}
        #qa3-panel input[type=text],#qa3-panel input[type=password],#qa3-panel select{
          width:100%;padding:5px 7px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;box-sizing:border-box}
        #qa3-panel .row{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
        #qa3-panel button.b{flex:1;min-width:62px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:7px;
          background:#f8fafc;cursor:pointer;font-size:12px;color:#1f2937}
        #qa3-panel button.b:hover{background:#f5f3ff;border-color:#7c3aed}
        #qa3-panel button.b.pri{background:linear-gradient(90deg,#7c3aed,#a78bfa);color:#fff;border-color:transparent;font-weight:700}
        #qa3-panel button.b.gold{background:linear-gradient(90deg,#d97706,#f59e0b);color:#fff;border-color:transparent;font-weight:700}
        #qa3-panel button.b.dan{background:#fff1f0;border-color:#f0a8a0;color:#b42318}
        #qa3-panel button.b.dan:hover{background:#ffe4e0}
        #qa3-panel .banner{padding:9px 11px;border-radius:8px;margin-bottom:8px;font-size:12px;
          border:1px solid transparent;line-height:1.6}
        #qa3-panel .now{padding:8px 10px;background:#f1f5f9;border-radius:7px;margin-bottom:8px;font-size:12px}
        #qa3-panel .r{padding:5px 0;border-bottom:1px dashed #eef2f7;font-size:12px}
        #qa3-panel .r .ok{color:#067647;font-weight:700}
        #qa3-panel .r .bad{color:#b42318;font-weight:700}
        #qa3-panel .r .t{color:#94a3b8}
        #qa3-panel .r .w{color:#94a3b8;font-size:11px}
        #qa3-panel .tip{font-size:11px;color:#64748b;margin-top:8px;line-height:1.5}
        #qa3-panel hr{border:0;border-top:1px solid #eef2f7;margin:10px 0}
        #qa3-panel .lock{font-size:11px;color:#067647;margin-top:6px}
        #qa3-panel .bookstat{font-size:11px;color:#7c3aed;margin-top:6px}
        #qa3-panel .bookbox{max-height:260px;overflow:auto;border:1px solid #eef2f7;border-radius:7px;
          padding:6px 8px;margin-top:6px;display:none;background:#fcfcff}
        #qa3-panel .bookbox .bk{padding:6px 0;border-bottom:1px dashed #eef2f7}
        #qa3-panel .bookbox .q{font-weight:600;color:#1f2937}
        #qa3-panel .bookbox .m{color:#94a3b8;font-size:11px}
        #qa3-panel .bookbox .wrong{color:#b42318;font-size:11px}
        #qa3-panel .bookbox .correct{color:#067647;font-size:11px}
        #qa3-panel .warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:7px 9px;
          border-radius:7px;font-size:11px;line-height:1.5;margin-top:8px}
      </style>
      <div class="hd"><span>答题助手 v3 · 错题本 + 满分冲刺</span><span class="mi" id="qa3-min">−</span></div>
      <div class="bd">
        <div class="banner" id="qa3-banner">尚未授权</div>
        <div class="now" id="qa3-now">就绪</div>
        <div class="bookstat" id="qa3-bookstat">📕 错题本：0 题</div>

        <div class="row">
          <button class="b pri" id="qa3-run">🚀 放任自流</button>
          <button class="b gold" id="qa3-perfect">🏁 满分冲刺</button>
          <button class="b dan" id="qa3-stop">■ 停</button>
        </div>
        <div class="row">
          <button class="b" id="qa3-once">只答本页（不翻页）</button>
          <button class="b" id="qa3-rescan">↻ 只抓题</button>
        </div>
        <div class="row">
          <button class="b" id="qa3-scan">📚 学习历史错题</button>
          <button class="b" id="qa3-book">📕 查看错题本</button>
          <button class="b dan" id="qa3-clear">🗑 清空</button>
        </div>

        <div class="warn">
          <b>满分冲刺</b>会自动交卷并在未满分时重新作答，交卷不可逆。<br>
          默认最多 <b id="qa3-maxlabel">8</b> 轮；到上限、读不到成绩或提示次数用完时自动停。
        </div>

        <hr>
        <label>取答案方式</label>
        <select id="qa3-provider">
          <option value="direct">直连接口（key 存浏览器）</option>
          <option value="bridge">走本地 DSH 桥（key 留插件里）</option>
        </select>
        <div id="qa3-direct-box">
          <label>接口地址（OpenAI 兼容，含 /v1）</label>
          <input type="text" id="qa3-base" />
          <label>API Key（可留空，部分免费接口不需要）</label>
          <input type="password" id="qa3-key" placeholder="sk-..." />
          <label>模型名</label>
          <input type="text" id="qa3-model" />
        </div>
        <div id="qa3-bridge-box" style="display:none">
          <label>本地桥地址</label>
          <input type="text" id="qa3-bridge" />
          <div class="tip">需插件里 <code>bridgeEnabled: true</code>。桥不可用时建议用直连。</div>
        </div>
        <label>每批题数 / 请求间隔(ms) / 满分冲刺最多轮数</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="qa3-batch" style="flex:1" />
          <input type="text" id="qa3-delay" style="flex:1" />
          <input type="text" id="qa3-maxrounds" style="flex:1" />
        </div>
        <label>追加提示（可选，例：本课程为劳动教育）</label>
        <input type="text" id="qa3-extra" />
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px">
          <input type="checkbox" id="qa3-keepgoing" />
          <span>有题没填上时仍继续翻页（否则停下等你）</span>
        </div>

        <div id="qa3-report"></div>
        <div class="bookbox" id="qa3-bookbox"></div>
        <div class="lock" id="qa3-lock"></div>
        <div class="tip">
          <b>推荐流程</b>：先点「📚 学习历史错题」把以前答过的回顾扫一遍 →
          点「🏁 满分冲刺」→ 脚本自动答、交、学、重考，直到满分。<br>
          <b>只想答一次</b>：点「🚀 放任自流」，到提交页会停下，交卷仍由你点。
        </div>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#qa3-min').onclick = () => {
      const bd = el.querySelector('.bd');
      bd.style.display = bd.style.display === 'none' ? 'block' : 'none';
    };

    /* 回填配置 */
    el.querySelector('#qa3-provider').value = CFG.provider;
    el.querySelector('#qa3-base').value = CFG.baseUrl;
    el.querySelector('#qa3-key').value = CFG.apiKey;
    el.querySelector('#qa3-model').value = CFG.model;
    el.querySelector('#qa3-bridge').value = CFG.bridgeUrl;
    el.querySelector('#qa3-batch').value = CFG.batch;
    el.querySelector('#qa3-delay').value = CFG.delayMs;
    el.querySelector('#qa3-maxrounds').value = CFG.maxRounds;
    el.querySelector('#qa3-extra').value = CFG.promptExtra;
    el.querySelector('#qa3-keepgoing').checked = !!CFG.keepGoingOnFailure;
    const maxlabel = el.querySelector('#qa3-maxlabel');
    if (maxlabel) maxlabel.textContent = String(CFG.maxRounds);

    const syncProvider = () => {
      const bridge = el.querySelector('#qa3-provider').value === 'bridge';
      el.querySelector('#qa3-direct-box').style.display = bridge ? 'none' : 'block';
      el.querySelector('#qa3-bridge-box').style.display = bridge ? 'block' : 'none';
    };
    el.querySelector('#qa3-provider').onchange = syncProvider;
    syncProvider();

    const readCfg = () => {
      CFG.provider = el.querySelector('#qa3-provider').value === 'bridge' ? 'bridge' : 'direct';
      CFG.bridgeUrl = el.querySelector('#qa3-bridge').value.trim() || DEFAULT_CFG.bridgeUrl;
      CFG.baseUrl = el.querySelector('#qa3-base').value.trim() || DEFAULT_CFG.baseUrl;
      CFG.apiKey = el.querySelector('#qa3-key').value.trim();
      CFG.model = el.querySelector('#qa3-model').value.trim() || DEFAULT_CFG.model;
      CFG.batch = parseInt(el.querySelector('#qa3-batch').value, 10) || 5;
      CFG.delayMs = parseInt(el.querySelector('#qa3-delay').value, 10) || 600;
      CFG.maxRounds = Math.max(1, parseInt(el.querySelector('#qa3-maxrounds').value, 10) || 8);
      CFG.promptExtra = el.querySelector('#qa3-extra').value.trim();
      CFG.keepGoingOnFailure = el.querySelector('#qa3-keepgoing').checked;
      if (maxlabel) maxlabel.textContent = String(CFG.maxRounds);
      saveCfg(CFG);
    };
    ['#qa3-provider', '#qa3-base', '#qa3-key', '#qa3-model', '#qa3-bridge',
      '#qa3-batch', '#qa3-delay', '#qa3-maxrounds', '#qa3-extra', '#qa3-keepgoing']
      .forEach(sel => {
        const n = el.querySelector(sel);
        n.addEventListener('change', readCfg);
        n.addEventListener('blur', readCfg);
      });

    el.querySelector('#qa3-run').onclick = () => { readCfg(); armSingle(); };
    el.querySelector('#qa3-perfect').onclick = () => { readCfg(); armPerfect(); };
    el.querySelector('#qa3-stop').onclick = () => {
      disarm();
      state.busy = false;
      setBanner('⏹ 已停止。不会再自动翻页/交卷。', 'stop');
      setNow('已停止');
      toast('已停止', 'warn');
      paintStatus();
    };
    el.querySelector('#qa3-once').onclick = () => { readCfg(); processPage({ advance: false }); };
    el.querySelector('#qa3-rescan').onclick = () => {
      const qs = scrapeQuestions();
      setNow(`抓到 <b>${qs.length}</b> 道题（仅本地，未上传）`);
      renderReport(qs.map(q => ({
        n: q.n, qno: q.qno, type: q.type, answer: '',
        ok: !!(q.options.length || q.inputType),
        why: `${q.type} · ${q.options.length} 选项`,
        text: q.text.slice(0, 60),
      })));
      console.table(qs.map(q => ({
        题号: q.qno, 题型: q.type, 已答: q.answered,
        题干: q.text.slice(0, 40), 选项数: q.options.length,
      })));
    };
    el.querySelector('#qa3-scan').onclick = async () => {
      setBanner('📚 正在学习历史错题…', 'run');
      try {
        const r = await scanHistory((m) => setNow(m));
        const st = bookStats();
        const rr = readRun();
        rr.scanned = true;
        writeRun(rr);
        setNow(`📚 已扫描 ${r.scanned}/${r.total} 个历史回顾；错题本 ${st.questions} 题。`);
        toast(`学习完成：${st.questions} 题`, 'ok');
        renderBookBox();
        const bs = document.getElementById('qa3-bookstat');
        if (bs) bs.textContent = `📕 错题本：${st.questions} 题 · 已知错选项 ${st.wrong} · 已知正确 ${st.correct}`;
      } catch (e) {
        setNow('学习失败：' + e.message);
        toast('学习失败', 'warn');
      }
    };
    el.querySelector('#qa3-book').onclick = () => {
      const box = document.getElementById('qa3-bookbox');
      if (!box) return;
      const show = box.style.display !== 'block';
      box.style.display = show ? 'block' : 'none';
      if (show) {
        renderBookBox();
        box.scrollIntoView({ block: 'nearest' });
      }
    };
    el.querySelector('#qa3-clear').onclick = () => {
      if (!confirm('确定清空错题本？此操作不可撤销。')) return;
      try { localStorage.removeItem(LS.book); } catch (e) { /* ignore */ }
      renderBookBox();
      paintStatus();
      toast('错题本已清空', 'ok');
    };

    (function drag() {
      const hd = el.querySelector('.hd');
      let sx, sy, ox, oy, on = false;
      hd.addEventListener('mousedown', e => {
        on = true; sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!on) return;
        el.style.left = (ox + e.clientX - sx) + 'px';
        el.style.top = (oy + e.clientY - sy) + 'px';
        el.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { on = false; });
    })();

    paintStatus();
  }

  /* ==================== 八、主流程：处理一页 ===================== */
  async function processPage(opts) {
    opts = opts || {};
    const run = readRun();

    if (state.busy) { log('已有任务在跑，跳过'); return; }
    if (!isAttempt()) {
      setNow('这一页不是作答页（回顾/入口页），不自动填。');
      return;
    }
    // 「只答本页」是手动触发，可以不带授权；自动翻页必须仍处于授权状态。
    if (opts.advance && !run.armed) { log('已停止，不再自动作答'); return; }
    if (CFG.provider === 'direct' && !CFG.apiKey &&
        !/pollinations|127\.0\.0\.1|localhost/i.test(CFG.baseUrl)) {
      setNow('⚠ 还没填 API Key。要么填上，要么把「取答案方式」切成走本地桥。');
      toast('请先填 API Key', 'warn');
      disarm();
      paintStatus();
      return;
    }
    if (run.pages >= MAX_PAGES_PER_ATTEMPT) {
      disarm();
      setBanner(`🛑 本 attempt 已处理 ${run.pages} 页，达到上限（${MAX_PAGES_PER_ATTEMPT}），已停机。`, 'err');
      return;
    }
    if (run.asked >= MAX_ASKS_PER_ATTEMPT) {
      disarm();
      setBanner(`🛑 本 attempt 已请求模型 ${run.asked} 批，达到上限（${MAX_ASKS_PER_ATTEMPT}），已停机。`, 'err');
      return;
    }

    const blocker = detectBlockers();
    if (blocker) {
      disarm();
      setBanner(`🛑 页面提示「${esc(blocker)}」，已停机，不硬闯。请手动检查。`, 'err');
      return;
    }

    state.busy = true;
    try {
      const questions = scrapeQuestions();
      if (!questions.length) {
        setNow('⚠ 本页没抓到题目。可能：已交卷 / 未解锁 / 本页无题。');
        disarm();
        paintStatus();
        return;
      }
      setNow(`本页 <b>${questions.length}</b> 道题，正在查错题本/问模型…`);

      const { answers, asks, trials } = await solveQuestions(questions, (m) => setNow(m));

      // 用户可能在等模型时点了「停」：必须重新读状态，绝不能用旧对象把 armed 写回来。
      const fresh = readRun();
      if (!fresh.armed) {
        setNow('⏹ 已停止：本页填好的答案不会提交。');
        paintStatus();
        return;
      }
      fresh.asked += asks;

      const report = [];
      let failed = 0;
      for (const q of questions) {
        const a = answers[q.n];
        const pr = applyAnswer(q, a);
        if (!pr.ok || !a) failed++;
        const isTrial = (trials || []).includes(q.n);
        report.push({
          n: q.n, qno: q.qno, type: q.type,
          answer: Array.isArray(a) ? a.join(' / ') : (a || ''),
          ok: pr.ok, why: pr.why + (isTrial ? ' · 模型未给答案，已试错' : ''),
          text: q.text.slice(0, 60),
        });
        renderReport(report.slice());
      }
      state.lastReport = report;
      log('本页填写结果', report);

      const okCount = questions.length - failed;
      setNow(`本页已填 <b>${okCount}/${questions.length}</b> 题` +
        (failed ? `，<b style="color:#b42318">${failed} 题没填上</b>` : '') +
        (opts.advance ? '<br>正在提交本页…' : ''));

      if (opts.advance) {
        const sig = pageSig();
        if (!fresh.processed.includes(sig)) fresh.processed.push(sig);
        fresh.pages += 1;
        fresh.attempt = attemptId();
        fresh.cmid = cmid() || fresh.cmid;
        writeRun(fresh);
      }

      if (failed > 0 && !CFG.keepGoingOnFailure) {
        disarm();
        setBanner(`⏸ 有 <b>${failed}</b> 题没自动填上，已停下等你处理。`, 'stop');
        toast(`${failed} 题没填上，已停下`, 'warn');
        return;
      }

      if (!opts.advance) { paintStatus(); return; }

      if (isSummary()) {
        if (fresh.mode === 'perfect' && fresh.armed) { await autoFinish(); return; }
        stopAtSubmitPage();
        return;
      }

      // 最后一页的按钮也叫 next，只是文字变成「结束答题…」
      if (!submitAttemptForm('next')) {
        if (fresh.mode === 'perfect' && fresh.armed) { await autoFinish(); return; }
        stopAtSubmitPage();
      }
      /* 之后页面会整页刷新，由 init() 续跑 */
    } catch (e) {
      warn('处理本页出错:', e);
      disarm();
      setBanner('🛑 出错了：' + esc(String(e && e.message || e)) + '（已停机）', 'err');
    } finally {
      state.busy = false;
    }
  }

  function stopAtSubmitPage() {
    disarm();
    const fin = findFinishButton() ||
      (findFinishForm() && findFinishForm().querySelector('button[type=submit], input[type=submit]'));
    if (fin) {
      fin.scrollIntoView({ block: 'center' });
      fin.style.outline = '3px solid #7c3aed';
      fin.style.outlineOffset = '2px';
      fin.style.boxShadow = '0 0 0 6px rgba(124,58,237,.18)';
    }
    const count = state.lastReport.length;
    setBanner('✅ <b>全部题目已答完，已停在提交页</b><br>'
      + '「全部提交并结束」已高亮 —— <b>由你自己点</b>。脚本不会替你交卷。', 'stop');
    setNow(count ? `本页提交前请扫一眼上面 ${count} 题的答案。` : '请确认后手动提交。');
    toast('已停在提交页，请手动提交', 'ok');
    paintStatus();
  }

  function stopPerfect(msg, kind) {
    const run = readRun();
    run.armed = false;
    run.phase = 'stopped';
    writeRun(run);
    setBanner(msg, kind || 'stop');
    setNow(msg);
    toast(msg.replace(/<[^>]+>/g, ''), kind === 'err' ? 'warn' : 'ok');
    paintStatus();
  }

  function finishPerfect(score, stat) {
    const run = readRun();
    run.armed = false;
    run.phase = 'done';
    run.lastScore = score;
    writeRun(run);
    const st = bookStats();
    setBanner(`🎉 <b>已满分</b> · ${score.got}/${score.max}（${score.pct}%）<br>`
      + `本轮学习 ${stat && stat.questions ? stat.questions : 0} 题；错题本现有 ${st.questions} 题。`, 'done');
    setNow('满分达成。错题本已保存，下次同题可直接用。');
    toast('🎉 满分达成', 'ok');
    paintStatus();
    renderBookBox();
  }

  /* ==================== 九、授权与页面入口 ====================== */
  function armSingle() {
    if (!isQuiz()) { toast('这一页不是 Moodle 测验页', 'warn'); return; }
    const run = readRun();
    const id = attemptId();
    if (run.attempt !== id || run.mode !== 'single') {
      run.attempt = id;
      run.processed = [];
      run.pages = 0;
      run.asked = 0;
      run.submits = 0;
      run.startedAt = new Date().toISOString();
    }
    const sig = pageSig();
    run.processed = run.processed.filter(x => x !== sig);
    run.armed = true;
    run.mode = 'single';
    run.cmid = cmid() || run.cmid;
    run.phase = 'answer';
    writeRun(run);
    paintStatus();
    toast('已授权：本次不自动交卷', 'ok');

    if (isAttempt()) {
      processPage({ advance: true });
    } else if (isReview()) {
      toast('回顾页不能直接作答，已跳到测验入口', 'warn');
      location.href = viewUrl(run.cmid);
    } else if (isStartConfirm()) {
      const b = findStartButton();
      if (b) b.click();
    } else if (isView()) {
      if (!startReattempt()) {
        stopPerfect('没找到「重新作答」按钮。', 'err');
        return;
      }
      waitAndClickStart(() => stopPerfect('已打开重新作答，但没找到「开始答题」按钮。', 'err'));
    }
  }

  function armPerfect() {
    if (!isQuiz()) { toast('这一页不是 Moodle 测验页', 'warn'); return; }
    const id = cmid() || '';
    const ok = confirm(
      '「满分冲刺」会自动：\n' +
      '1. 答完并交卷；\n' +
      '2. 从回顾页记录错题；\n' +
      '3. 未满分时自动重新作答；\n' +
      `4. 最多 ${CFG.maxRounds} 轮，到上限自动停。\n\n` +
      '交卷不可逆，确定开始吗？'
    );
    if (!ok) return;

    const run = readRun();
    run.armed = true;
    run.mode = 'perfect';
    run.cmid = id || run.cmid;
    run.attempt = attemptId();
    run.round = 1;
    run.maxRounds = Math.max(1, parseInt(CFG.maxRounds, 10) || 8);
    run.processed = [];
    run.pages = 0;
    run.asked = 0;
    run.submits = 0;
    run.phase = 'answer';
    run.lastScore = null;
    run.startedAt = new Date().toISOString();
    run.scanned = false;
    writeRun(run);
    paintStatus();
    toast('🏁 满分冲刺已开启', 'ok');

    if (isAttempt()) {
      processPage({ advance: true });
    } else if (isSummary()) {
      autoFinish();
    } else if (isReview()) {
      location.href = viewUrl(run.cmid);
    } else if (isStartConfirm()) {
      const b = findStartButton();
      if (b) b.click();
    } else if (isView()) {
      scanThenStart(run);
    } else {
      stopPerfect('当前页面不支持满分冲刺。', 'err');
    }
  }

  async function scanThenStart(run) {
    setBanner('📚 满分冲刺：先学习历史错题…', 'run');
    try {
      const r = await scanHistory((m) => setNow(m));
      log('历史扫描完成', r);
      const st = bookStats();
      setNow(`📚 已学习 ${r.scanned}/${r.total} 个回顾；错题本 ${st.questions} 题。正在开始新一轮…`);
    } catch (e) {
      warn('历史扫描失败', e);
      setNow('历史扫描失败，继续用现有错题本开始。');
    }

    // 扫描可能耗时几十秒；用户中途点「停」时不能再开始新一轮。
    const fresh = readRun();
    if (!fresh.armed || fresh.mode !== 'perfect') {
      log('扫描结束后发现已停机，不再开始新一轮');
      setBanner('⏹ 已停止，不会开始新一轮。', 'stop');
      return;
    }
    fresh.scanned = true;
    writeRun(fresh);
    if (!startReattempt()) {
      stopPerfect('没找到「重新作答/开始答题」按钮，可能次数已用完或测验已关闭。', 'err');
      return;
    }
    waitAndClickStart(() => stopPerfect('已打开重新作答，但没找到「开始答题」按钮。', 'err'));
  }

  /* ==================== 十、各页面 init ========================= */
  function onAttemptPage(run) {
    if (!document.querySelector('div.que')) {
      log('作答页但没有题目（可能是确认页）');
      return;
    }
    const n = document.querySelectorAll('div.que').length;

    if (run.armed) {
      const sig = pageSig();
      if (run.processed.includes(sig)) {
        disarm();
        setBanner('🛑 又回到了已答过的这一页（翻页可能失败，或你手动退回）。已停机，绝不重复作答。', 'err');
        setNow('已停机。若确实要重答本页，点「🚀 放任自流」会重新处理本页。');
        paintStatus();
        return;
      }
      run.attempt = attemptId();
      run.cmid = cmid() || run.cmid;
      writeRun(run);
      setBanner(run.mode === 'perfect'
        ? `🟢 满分冲刺第 <b>${run.round}/${run.maxRounds}</b> 轮：正在处理本页…`
        : '🟢 放任自流进行中：正在处理本页…', 'run');
      toast('续跑：正在处理本页', 'ok');
      setTimeout(() => processPage({ advance: true }), Math.max(200, Number(CFG.settleMs) || 1200));
      return;
    }

    setNow(`作答页 · 本页 <b>${n}</b> 道题<br>点「🚀 放任自流」（不自动交卷）或「🏁 满分冲刺」（自动交卷+重考）。`);
    if (n) renderReport(scrapeQuestions().map(q => ({
      n: q.n, qno: q.qno, type: q.type, answer: '',
      ok: !!(q.options.length || q.inputType),
      why: q.type, text: q.text.slice(0, 60),
    })));
  }

  function onSummaryPage(run) {
    if (run.armed && run.mode === 'perfect') {
      // 已经发过一次交卷请求却没跳走（刷新/回退回到摘要页）：别再交一次。
      if (run.phase === 'submitting') {
        stopPerfect('🛑 已经提交过一次，但没有跳到回顾页。已停机，请手动确认成绩。', 'err');
        return;
      }
      setBanner('🟢 满分冲刺：已到提交页，准备自动交卷…', 'run');
      setNow('正在自动交卷，请稍候…');
      setTimeout(() => {
        if (!readRun().armed) return;
        autoFinish();
      }, 900);
      return;
    }
    if (run.armed) {
      stopAtSubmitPage();
      return;
    }
    setNow('摘要/提交页 · 请确认后手动提交');
    paintStatus();
  }

  function onReviewPage(run) {
    ensureCmid(run);
    const stat = recordReviewDoc(document, { attempt: attemptId() });
    const score = parseScore();
    if (score) {
      run.lastScore = score;
      run.lastReviewAttempt = attemptId();
      writeRun(run);
    }

    const st = bookStats();
    setNow(`回顾页 · 本轮 ${stat.questions} 题，学习 ${stat.learned} 题` +
      (score ? `<br>成绩：<b>${score.got}/${score.max}</b>（${score.pct}%）` : '') +
      `<br>错题本：${st.questions} 题 · 已知错选项 ${st.wrong} · 已知正确 ${st.correct}`);
    renderBookBox();
    paintStatus();

    if (!(run.armed && run.mode === 'perfect')) return;

    // 只看"本轮刚交的那张卷"的回顾。用户手动翻旧回顾时，学习错题可以，
    // 但不能拿旧分数驱动满分冲刺（否则会误判/白耗作答次数）。
    if (run.attempt && attemptId() !== String(run.attempt)) {
      setNow(`📚 这是历史回顾页（attempt ${attemptId()}），已学习错题；`
        + `本轮冲刺对应 attempt ${run.attempt}，不在此页决策。`);
      return;
    }

    if (!score) {
      stopPerfect('🛑 回顾页读不到成绩，已停机。请手动确认。', 'err');
      return;
    }
    if (score.full) {
      finishPerfect(score, stat);
      return;
    }
    if (run.round >= run.maxRounds) {
      stopPerfect(`🛑 已到最大轮数（${run.maxRounds}），当前 ${score.got}/${score.max}，已停机。`, 'stop');
      return;
    }

    run.round += 1;
    run.processed = [];
    run.pages = 0;
    run.asked = 0;
    run.phase = 'restart';
    writeRun(run);
    setBanner(`🟡 本轮 <b>${score.got}/${score.max}</b>，未满分；`
      + `错题已记录，准备第 <b>${run.round}/${run.maxRounds}</b> 轮…`, 'stop');
    toast(`本轮 ${score.got}/${score.max}，准备重考`, 'warn');
    setTimeout(() => { location.href = viewUrl(run.cmid); }, 1800);
  }

  function onViewPage(run) {
    const startBtn = findStartButton();
    if (startBtn) {
      if (run.armed) {
        setBanner(run.mode === 'perfect'
          ? `🟢 满分冲刺第 <b>${run.round}/${run.maxRounds}</b> 轮：正在开始答题…`
          : '🟢 正在开始答题…', 'run');
        setNow('已找到「开始答题」，自动点击…');
        setTimeout(() => {
          if (!readRun().armed) return;
          startBtn.click();
        }, 600);
      } else {
        setNow('测验入口确认页 · 点「开始答题」开始。');
        paintStatus();
      }
      return;
    }

    if (run.armed && run.mode === 'perfect') {
      if (run.phase === 'done' || run.phase === 'stopped') {
        setNow('满分冲刺已结束。');
        paintStatus();
        return;
      }
      // 已经交过卷却没进回顾页（老师关闭了回顾/权限不足）：再点"重新作答"
      // 只会无限重考且永远学不到东西，必须停机。
      if (run.phase === 'submitting') {
        stopPerfect('🛑 交卷后没有进入回顾页，无法读取成绩/学习错题（可能老师关闭了回顾）。'
          + '已停机，请手动查看成绩。', 'err');
        return;
      }
      if (!run.scanned) {
        scanThenStart(run);
        return;
      }
      setBanner(`🟢 满分冲刺第 <b>${run.round}/${run.maxRounds}</b> 轮：准备重新作答…`, 'run');
      setNow('正在点击「重新作答测验」…');
      setTimeout(() => {
        if (!readRun().armed) return;
        if (!startReattempt()) {
          stopPerfect('没找到「重新作答」按钮，可能次数已用完或测验已关闭。', 'err');
        } else {
          waitAndClickStart(() => stopPerfect('已打开重新作答，但没找到「开始答题」按钮。', 'err'));
        }
      }, 800);
      return;
    }

    if (run.armed && run.mode === 'single') {
      setBanner('🟢 放任自流：准备开始作答…', 'run');
      setTimeout(() => {
        if (!readRun().armed) return;
        if (!startReattempt()) stopPerfect('没找到「重新作答」按钮。', 'err');
      }, 800);
      return;
    }

    const btn = findReattemptForm();
    const n = document.querySelectorAll('a[href*="review.php?attempt="]').length;
    setNow(`测验入口页 · 历史回顾 ${n} 个<br>点「📚 学习历史错题」先扫错题，或直接点「🏁 满分冲刺」。`);
    if (btn) btn.scrollIntoView({ block: 'center' });
    paintStatus();
  }

  function init() {
    if (!isQuiz()) return;
    buildPanel();

    const run = readRun();

    if (isReview()) { onReviewPage(run); return; }
    if (isStartConfirm()) { onViewPage(run); return; }
    if (isSummary()) { onSummaryPage(run); return; }
    if (isAttempt()) { onAttemptPage(run); return; }
    if (isView()) { onViewPage(run); return; }

    setNow('当前是测验相关页，但没有可处理的题目。');
    paintStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
