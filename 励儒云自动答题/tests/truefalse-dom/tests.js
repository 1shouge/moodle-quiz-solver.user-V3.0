(function () {
  const R = [];
  const ok = (name, cond, detail) => R.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  const QA = window.__qa;
  if (!QA) {
    window.__testResults = [{ name: 'bundle loaded', ok: false, detail: 'window.__qa missing' }];
    return;
  }

  const qs = QA.scrapeQuestions();
  ok('抓到 7 道判断题', qs.length === 7, '实际 ' + qs.length);
  qs.forEach((q, i) => {
    ok('第 ' + q.n + ' 题抓到 2 个选项', q.options.length === 2, q.options.map(o => o.label).join(' | '));
    ok('第 ' + q.n + ' 题选项文字非空', q.options.every(o => o.label && o.label.trim()), q.options.map(o => o.label).join(' | '));
  });

  const [q1, q2, q3, q4, q5, q6, q7] = qs;

  const eq = (q, raw, want) => {
    const got = QA.resolveAnswer(q, raw, { wrong: [], correct: [] });
    ok('resolve ' + q.n + ' ' + JSON.stringify(raw), JSON.stringify(got) === JSON.stringify(want),
      'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
  };

  eq(q1, '正确', ['对']);
  eq(q1, '错误', ['错']);
  eq(q1, 'True', ['对']);
  eq(q1, 'False', ['错']);
  eq(q1, 'T', ['对']);
  eq(q1, 'F', ['错']);
  eq(q1, 'B', ['错']);
  eq(q2, '对', ['正确']);
  eq(q2, '错误', ['错误']);
  eq(q3, '正确答案：对', ['对']);
  eq(q4, 'False', ['错']);
  eq(q5, '正确', ['正确']);
  eq(q7, '对', ['正确']);
  eq(q7, 'False', ['错误']);
  eq(q7, 'A', ['正确']);

  const appl = (q, raw, wantLabel) => {
    const r = QA.applyAnswer(q, [raw]);
    const hit = q.options.find(o => o.label === wantLabel);
    ok('apply ' + q.n + ' ' + JSON.stringify(raw), r.ok && hit && hit.el.checked,
      JSON.stringify(r) + ' checked=' + (hit && hit.el.checked));
  };
  appl(q1, '正确', '对');
  appl(q1, 'False', '错');
  appl(q2, '对', '正确');
  appl(q2, '错误', '错误');
  appl(q3, 'T', '对');
  appl(q4, '错误', '错');
  appl(q5, '对', '正确');
  appl(q6, 'True', '对');
  appl(q7, '错误', '错误');
  appl(q7, 'T', '正确');

  const tri = (q, mem, want) => {
    const got = QA.trialAnswer(q, mem);
    ok('trial ' + q.n + ' ' + JSON.stringify(mem), JSON.stringify(got) === JSON.stringify(want),
      'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
  };
  tri(q1, { wrong: ['对'], correct: [] }, ['错']);
  tri(q2, { wrong: ['错误'], correct: [] }, ['正确']);
  tri(q4, { wrong: ['错'], correct: [] }, ['对']);
  tri(q1, { wrong: [], correct: ['正确'] }, ['对']);

  const det = (q, mem, want) => {
    const got = QA.deterministicAnswer(q, mem);
    ok('deterministic ' + q.n + ' ' + JSON.stringify(mem), JSON.stringify(got) === JSON.stringify(want),
      'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
  };
  det(q2, { wrong: ['错误'], correct: [] }, ['正确']);
  det(q2, { wrong: [], correct: ['对'] }, ['正确']);
  det(q4, { wrong: ['对'], correct: [] }, ['错']);

  // 多选：修一下 correct is not defined 这种回归
  const qm = {
    type: 'multichoiceset',
    options: [
      { key: 'A', label: '甲' },
      { key: 'B', label: '乙' },
      { key: 'C', label: '丙' },
    ],
  };
  det(qm, { wrong: [], correct: ['甲', '乙'] }, null);
  det(qm, { wrong: ['丙'], correct: ['甲', '乙'] }, ['甲', '乙']);
  {
    const got = QA.trialAnswer(qm, { wrong: ['丙'], correct: ['甲'] });
    ok('trial 多选补一个未知项', JSON.stringify(got) === JSON.stringify(['甲', '乙']),
      'got=' + JSON.stringify(got));
  }

  // 回顾页抓取
  const tpl = document.getElementById('review-fixtures');
  const rq = QA.reviewQuestions(tpl.content);
  ok('回顾页抓到 3 题', rq.length === 3, '实际 ' + rq.length);
  if (rq.length === 3) {
    const labels = q => q.opts.map(o => o.label).join(' | ');
    ok('回顾页标准结构标签', labels(rq[0]) === '正确 | 错误', labels(rq[0]));
    ok('回顾页标准结构 selected=正确',
      rq[0].opts[0].checked === true && rq[0].opts[0].incorrect === true &&
      rq[0].opts[1].correct === true, JSON.stringify(rq[0].opts));
    ok('回顾页无 input 仍能推断 selected', rq[1].opts[0].checked === true,
      JSON.stringify(rq[1].opts));
    ok('回顾页多包一层标签', labels(rq[2]) === '正确 | 错误', labels(rq[2]));
    ok('回顾页多包一层 selected=错误', rq[2].opts[1].checked === true, JSON.stringify(rq[2].opts));
  }

  window.__testResults = R;
})();
