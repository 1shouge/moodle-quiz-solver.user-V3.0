
const CFG = { delayMs: 0, batch: 5, promptExtra: '' };
const LS = { cache: 'qa_test_cache' };
function warn(...a) { (globalThis.__warns = globalThis.__warns || []).push(a.map(String).join(' ')); }
function log() {}
function cacheAnswer() {}
function cachedAnswer() { return null; }

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
globalThis.__qa = {
  scrapeQuestions, applyAnswer, resolveAnswer, rawToTexts,
  trialAnswer, deterministicAnswer, tfCanonical, optEq, optionLabel,
  reviewQuestions,
};
