# 项目交接笔记（答题助手 v3 · 错题本 + 满分冲刺）

> 这份文件是给"下一位接手的人/下一次会话"看的，不是用户文档。
> 用户文档见 `docs/答题助手v3-错题本与满分冲刺.md`。

## 1. 本次任务目标

1. 以 `userscripts/moodle-quiz-solver.user.js`（v2.1.0）为基础。
2. 增加"错题本"：记录错题**文字**，因为 Moodle 每次重考会打乱 ABCD 选项顺序。
3. 增加"满分冲刺"：自动提交 → 从回顾页学习错题 → 自动重考 → 直到满分。
4. 用 `https://moodle.scnu.edu.cn/mod/quiz/view.php?id=872663`（专题二测验）实测。
5. 随时写项目说明，防止上下文丢失。

## 2. 环境与账号

- 工作目录：`G:\SCNU-Liru-Online-Courses-main\SCNU-Liru-Online-Courses-main`
- 参考脚本：`userscripts/moodle-quiz-solver.user.js`（v2.1.0）
- 原脚本备份：`userscripts/legacy/moodle-quiz-solver-v2.1.0.user.js`
- 实测站点：砺儒云课堂（Moodle 4.x + lambda2 主题）
- 统一认证账号由用户提供：`202633332165`；**密码没有写进仓库**。
- 当前实测测验：`cmid=872663`，5 题，每题 2 分，满分 10 分，30 分钟，评分方法"最高分"。

## 3. 已完成的实测结果（2026-11-16）

- 第 6 次作答：8.0/10.0（只错第 1 题）
- 第 7 次作答：**10.0/10.0（100%）**
- 结论：该测验目前已经是满分；后续脚本测试不要再盲目消耗作答次数。

### 第 7 次满分的答案（按**选项文字**记，不按 ABCD）

1. 以下哪个不是劳模精神的时代价值()
   - **社会文明进步的重要尺度**
2. 新时代的奋斗就是"撸起袖子加油干"，不包括()
   - **蛮干**
3. 劳动精神的生成逻辑包括()
   - **实践逻辑：新时代的伟大实践**
   - **理论逻辑：马克思主义劳动思想**
   - **制度逻辑：中国特色社会主义制度**
   - **文化逻辑：中华优秀传统文化**
4. 工匠精神的内涵包括()
   - **精益求精**
   - **求实创新**
   - **爱岗敬业**
   - （诚实守信是错的）
5. 新时代劳动精神以马克思主义劳动思想为理论根基，包括()
   - **奋斗精神**
   - **创新创造精神**
   - **奉献精神**
   - （团队精神是错的）

## 4. 关键 DOM / 行为发现（v3 必须遵守）

### 4.1 回顾页（review.php）

- 题目仍是 `div.que`。
- 选项行：`div.answer > div`（class 为 `r0/r1`）。
- **选中且正确**：行 class 含 `correct`。
- **选中且错误**：行 class 含 `incorrect`。
- **未选中的正确项**：默认**不显示**（本校 review 选项没有开放"正确答案"）。
- 题目状态：`.state` 文本为 `正确 / 错误 / 未作答 / 部分正确`。
- 因此：
  - 单选错题：选中的那一项一定是错的。
  - 多选错题：选中且带 `correct` 的是真正确；选中且带 `incorrect` 的是真错误；未选项未知。
  - 整题 `正确`：选中的集合就是完整正确答案；**未选项全部是错的**（可反推）。
- 成绩表：`table.quizreviewsummary`，文本形如 `成绩 10.0/10.0 (100%）`。

### 4.2 作答页（attempt.php）

- 题目仍在 `div.que`。
- 选择项输入框在 `div.answer > div` 内。
- **判断题（`que truefalse`）**：`div.answer > div.r0/.r1`，两个 `input[type=radio]`，
  `value=1` 表示「对」、`value=0` 表示「错」；input id 形如
  `q6960941:3_answertrue` / `q6960941:3_answerfalse`；**`<label>` 自身带
  `class="ms-1"`**。清理图标时若把 `.ms-1` 整块删掉，label 文字就没了（v3.0.0 的 bug）。
- 多选是 `input[type=checkbox]`，每个 checkbox 前面有一个同名 hidden `value=0`（Moodle 的未选哨兵）。
- 下一页按钮：`input#mod_quiz-next-nav[name=next]`，value 可能是 `下一页`，最后一页是 `结束答题…`。
- **坑 1：不要 `checked = true` 后再 `dispatchEvent('click')`。**
  checkbox 会被再切换一次，变回未选。v2.1.0 就是这样丢掉多选答案的。
- **坑 2：不要随便 `dispatchEvent('change')`。**
  本校主题/插件会在 change 时自动保存并整页刷新，脚本刚设置的答案可能被旧状态覆盖。
- **可靠做法**：只设置 `input.checked = true/false`（或 `.value`），然后**直接提交 form**。
- **可靠提交**：`#responseform` 的 `action` 是 `processattempt.php?cmid=...`。
  调用 `form.submit()` 前，临时加一个 `<input type=hidden name="next" value="下一页">`，
  因为 `form.submit()` 不会带上被点击按钮的 name/value。
  这样多选答案能稳定保存（已实测 Q3/Q4/Q5）。

### 4.3 概要页（summary.php）

- 提交按钮在 `form#frm-finishattempt` 内，hidden `finishattempt=1`。
- 按钮文字是 **"全部提交并结束"**（不是 v2.1.0 里写的"提交所有答案并结束"）。
- 点击按钮会弹 `.modal.show`，确认按钮是
  `.modal.show .modal-footer button[data-action="save"]`。
- **满分冲刺**可以直接 `document.getElementById('frm-finishattempt').submit()` 绕过确认框；
  如果没跳转，再退回"点按钮 + 点 modal 确认"。

### 4.4 重新作答流程

1. `view.php?id=<cmid>` 上有 `form[action*="startattempt.php"]` + 按钮"重新作答测验"。
2. 点击后到 `startattempt.php` 确认页，有 `input#id_submitbutton`（"开始答题"）。
3. 点击"开始答题"才真正进入 `attempt.php?attempt=...`。
4. 脚本在满分冲刺模式下要能自动走完这三步。

## 5. v3 的设计

### 5.1 错题本数据（localStorage `scnu_quiz_wrongbook_v1`）

按**题目文字**做 key，绝不按 ABCD：

```json
{
  "multichoice|以下哪个不是劳模精神的时代价值": {
    "text": "以下哪个不是劳模精神的时代价值()",
    "type": "multichoice",
    "options": ["培育时代新人的重要手段", "..."],
    "wrong": ["文化自信的重要支撑", "实现中国梦的重要力量", "培育时代新人的重要手段"],
    "correct": ["社会文明进步的重要尺度"],
    "lastState": "错误",
    "updatedAt": 1760000000000
  }
}
```

- 选项文字先做归一化：去空白、去标点、去 `A.` 前缀、转小写。
- 整题正确时：`correct = 选中项`，`wrong = 其余所有选项`。
- 单选错题：`wrong += 选中项`。
- 多选错题：`correct += 行 class 含 correct 的选中项`，`wrong += 行 class 含 incorrect 的选中项`。
- 如果多选"判错但所有已选项都正确"：记一个 `hintMissing`，提示模型"上次漏选了"。

### 5.2 做题时的答案决策

1. 先查错题本：
   - 单选：排除 `wrong` 后只剩一个 → 直接选；有 `correct` → 直接选。
   - 多选：`correct` 必选；`wrong` 必不选；剩余项交给模型。
2. 不需要模型的题直接填，省 API。
3. 需要模型的题，把"已确认错误/已确认正确/上次漏选"写进 prompt。
4. 模型返回后：
   - 接受字母或选项文字；字母按**当前页面**的 ABCD 映射。
   - 过滤掉 `wrong`；多选补上 `correct`。
   - 单选若模型给了错误项，自动改用剩余候选。
5. 缓存也按题目文字存**选项文字**，选项顺序变了也能用；与错题本冲突时以错题本为准。
6. **模型没给答案时试错**（`trialAnswer()`，只对选择题）：接口失败、返回空、JSON 里
   没有这题、或解析出的选项全在 `wrong` 里，就在「不在 wrong 中」的选项里试一个。
   单选/判断优先已知正确项，否则第一个未知项；多选选上所有已知正确项 + 一个未知项，
   什么都不知道时先只试一个。报告里标「模型未给答案，已试错」。回顾页反馈后，
   试错的选项会进 `correct` 或 `wrong`，下一轮据此换选项。

### 5.3 满分冲刺状态机（localStorage `scnu_quiz_run_v2`）

- `mode = 'single' | 'perfect'`
- `armed = true`
- `round`：当前第几轮（从 1 开始）
- `maxRounds`：默认 8（可在面板改）
- `phase`：`answer | restart | submitting | done`
- `processed`：本 attempt 已处理的页面签名
- `lastScore`：`{got,max}`
- `scanned`：是否已扫过历史回顾

流程：

```
view.php（用户点满分冲刺）
  → 扫一遍所有"回顾"链接，学习历史错题（只 GET）
  → 点"重新作答测验"
startattempt.php
  → 点"开始答题"
attempt.php
  → 抓题 → 错题本/模型 → 填 → form.submit(next)
  → 最后一页 → summary.php
summary.php
  → 自动 form#frm-finishattempt.submit()
review.php
  → 记录错题 → 读成绩
  → 满分：停，写错题本
  → 未满分且 round < maxRounds：round++ → 回 view.php
```

### 5.4 安全边界

- `放任自流` 保持 v2 行为：**不自动交卷**。
- `满分冲刺` 会在 `confirm()` 明确提示后自动交卷、自动重考；这是用户本次明确要求。
- 到最大轮数、读不到成绩、出现"次数用完/测验关闭"等提示时立即停机。
- 不伪造分数、不直接改服务端数据；只操作当前页表单。

## 6. 代码状态 / 待办

- [x] 备份 v2.1.0
- [x] 实测并确认满分答案
- [x] 确认 DOM 选择器、表单提交方式、自动交卷方式
- [x] 写 v3 脚本
- [x] 用真实页面验证错题本扫描
- [x] 更新 README / 使用文档
- [x] 用本地模拟 Moodle 跑通完整「错题 → 重考 → 满分」循环
- [x] 复盘并修复状态机竞态 / 无回顾时无限重考等问题（见 6.1）

### 6.1 第二轮复盘修复（2026-11-16）

本地 mock（两页三题、每轮打乱选项、回顾页不显示未选正确项）跑通后，又补了这些：

1. **等模型时点「停」可能仍提交**：`processPage` 原来用异步开始前的 `run` 对象写回，
   会把 `armed` 复活。现在模型返回后重新 `readRun()`，未授权就丢弃本页、不提交。
2. **无回顾页时无限重考**：交卷后若 Moodle 直接回 `view.php`，原逻辑会一直点
   「重新作答」且永远读不到成绩。现在 `autoFinish` 写 `phase='submitting'`，
   入口页看到它立即停机并提示「没有进入回顾页」。
3. **历史回顾页误驱动本轮**：满分冲刺现在只认 `attemptId() === run.attempt` 的回顾页；
   翻旧回顾只学习错题，不拿旧分数做决策。
4. **错题本旧记忆误伤**：`bookMemory()` 只保留当前题目存在的选项；若旧记录把
   当前所有选项都标成错误，整条忽略（题目/选项被改过）。
5. **多选「已知正确数 + 错误数」计算**：改为只数当前可选集合，避免旧选项导致漏选。
6. **自动交卷保护**：`submits` 计数，超过 `maxRounds + 2` 强制停机；「最多可以作答
   N 次」不再被误判成次数用完。
7. **停按钮时序**：入口页/摘要页的延时点击都会在执行前重新检查 `armed`；
   摘要页若发现 `phase='submitting'`（已经交过一次却没跳走），不再重复交卷。
8. **空答案不再交白卷**：新增 `trialAnswer()`。模型接口失败/返回空/选项全被错题本
   排除时，选择题用「错题本里没试过的选项」兜底；`solveQuestions()` 返回 `trials`，
   面板报告标记「模型未给答案，已试错」。填空/简答无选项，仍留空。

mock 验证结果：

- 第 1 轮故意答错（单选错、多选漏选）→ 回顾页学习 → 第 2 轮 3/3 满分；
  第 2 轮的单选第 1 题由错题本直接确定，**没有请求模型**。
- 关闭回顾后只交 1 次就停在入口页，`armed=false`、`phase=stopped`。
- 等模型时点「停」：`answers={}`、attempt 未完成、页面提示「本页填好的答案不会提交」。
- 「放任自流」跑完两页后停在 `summary.php`，attempt 保持未完成。
- 模拟接口对单选 1、3 返回空：第 1 轮提交的是试错答案（`固定成本分摊` / `会计账面成本`），
  不是空；回顾学习后第 2 轮 `3/3`。
- 模拟接口直接 500：三道选择题全被试错填上（`固定成本分摊` / `团队精神` / `沉没成本`）
  并提交，没有空题；「放任自流」下同样停在 `summary.php` 等用户交卷。

真实站复验（更新后的脚本重新注入）：

- 回顾页：`🎉 已满分 · 10/10`，学习 5 题，错题本 `5 题 / 错 8 / 对 12`。
- 入口页：识别 8 个历史回顾，点「学习历史错题」扫描 `8/8` 成功，错题本不变。

### 6.2 判断题填不上修复（2026-11-17）

真实站 `专题九测验`（`id=872709`）第 3 题 DOM：

```html
<div class="que truefalse ...">
  <div class="answer">
    <div class="r0"><input type="radio" name="q6960941:3_answer" value="1"
        id="q6960941:3_answertrue"><label for="..." class="ms-1">对</label></div>
    <div class="r1"><input type="radio" name="q6960941:3_answer" value="0"
        id="q6960941:3_answerfalse"><label for="..." class="ms-1">错</label></div>
  </div>
</div>
```

- **根因**：`optionLabel()` 清理回顾页图标时写了
  `clone.querySelectorAll('i, .icon, .ms-1').forEach(remove)`。Moodle 4.x 判断题的
  `<label>` 本身带 `class="ms-1"`，于是选项文字被整块删掉，变成空字符串。
  多选题的 label 没有这个 class，所以只有判断题「经常填不上」。
- 真实页验证：同一行 `oldLabel → ""`，`newLabel → "对"`。
- 修复：
  1. 只删除 `i, .icon`，不再删除 `.ms-1`。
  2. 选项行必须是「恰好一个 radio/checkbox」才算一行，避免主题多包一层时把
     整个 `.inner` 当成一个选项。
  3. 如果 `div.answer > div` 全抓不到，直接扫题目内所有 radio/checkbox 兜底；
     仍取不到 label 时，用 `_answertrue/_answerfalse` 或 `value=1/0` 生成「对/错」。
  4. 判断题按语义匹配：`对 / 正确 / 是 / True / T / √` ↔
     `错 / 错误 / 否 / False / F / ×`，模型不同写法也能选中。
  5. 回顾页同样支持「没有 input」的判断题行，并从 `incorrect` 行推断选中项。
- 新增 53 项浏览器 DOM 回归测试（`tests/truefalse-dom/`：7 种判断题结构 ×
  抓取/解析/填答/试错 + 3 种回顾页结构），全部通过；`node --check` 通过。

### 6.3 v3.0.1 回归修复（2026-11-17）

- 现象：多选题报 `correct is not defined`，面板显示「已停机」。
- 原因：6.2 把 `deterministicAnswer()` 里的 `wrong/correct` 集合改成
  `wrongList/correctList`，但多选分支里还留着一处
  `!correct.has(norm(o.label))`。只要遇到 `multichoiceset` 就会抛 ReferenceError。
- 修复：改成 `!correctList.some(x => optEq(q, x, o.label))`；同时把「整题正确」
  写 `entry.wrong` 的 `norm` 比较也改成 `optEq`，避免判断题语义不一致。
- 回归：`tests/truefalse-dom/` 增加多选 `deterministicAnswer` / `trialAnswer`
  用例；现共 56 项全部通过。版本升到 **v3.0.2**。

## 7. 已知风险

- 本校 review 默认不显示未选中的正确答案，所以"错题本"需要靠**整题正确的那次**或**排除法**补全。
- 如果老师关闭了"回顾"权限，review.php 可能看不到 correct/incorrect 标记；脚本会退化为只记录"这题错过"，靠模型重答。
  若交卷后根本不进回顾页，满分冲刺会**主动停机**，不会无限重考。
- Pollinations 等免费接口可能返回非 JSON；脚本有解析兜底，但建议用自己的稳定 API。
- 自动交卷不可逆，务必确认 `maxRounds` 和测验剩余次数；脚本有 `submits` 保护，
  但**不会替你确认是否还有作答次数**。
- 「最高分」评分法下重考低分不会覆盖高分；如果老师改成「最后一次」，满分冲刺可能拉低成绩，
  开始前必须自己确认评分方法。
- 错题本按题干文字做 key：老师改一个字就成新题，旧记忆不会自动迁移（这是有意的安全取舍）。
