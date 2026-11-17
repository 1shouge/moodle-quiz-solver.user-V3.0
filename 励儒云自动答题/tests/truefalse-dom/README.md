# 判断题 DOM 回归测试

用真实 Moodle 4.x 判断题结构（以及几种主题变体）验证 userscript 的
抓题、答案解析、填答、试错、回顾页学习逻辑。

## 为什么需要

Moodle 4.x 判断题的 `<label>` 自带 `class="ms-1"`。v3.0.0 清理图标时误删了
`.ms-1`，导致「对/错」读成空字符串，判断题填不上。这个测试专门锁住这个坑：

- 标准结构（`div.answer > div.rN`，label 带 `ms-1`）
- 标签是「正确/错误」而不是「对/错」
- 主题多包一层
- 没有 label 文字，只能靠 `_answertrue/_answerfalse` 或 `value=1/0`
- 完全没有 `rN` / `answer` 直接子项
- 回顾页有 input / 没有 input

## 运行

```bash
cd tests/truefalse-dom
node build.mjs
python -m http.server 8777 --bind 127.0.0.1
```

然后打开 <http://127.0.0.1:8777/index.html>，页面会执行测试并写入
`window.__testResults`。用浏览器控制台查看：

```js
window.__testResults.filter(x => !x.ok)
```

没有失败项即通过。

`qa-bundle.js` 是构建产物，不需要提交；`build.mjs` 会从
`../../userscripts/moodle-quiz-solver.user.js` 重新生成。
