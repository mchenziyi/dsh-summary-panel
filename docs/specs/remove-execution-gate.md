# Spec：拆除执行门禁（v0.4.0）

> 决策见 `docs/adr/0003-remove-the-execution-gate.md`。本文件只讲怎么拆、拆成几张票、每张票怎么算完成。
> 票在 GitHub：**#16 → #17 → #18 → #19 → #20**（串行，后一张 blocked by 前一张）。

## 目标（一句话）

把仓库从「一层会在工具调用前拦截的强制执行系统」变回「一个展示 Agent 维护的任务树的面板」。行为上，Agent 改文件不再需要任何前置动作；面板照常显示谁在做。

## 不在本 spec 里

- 面板可见性的新功能（空态、动态演示、批量验收）——见 issue #15
- 文件系统隔离 / 独立工作树 —— 本版明确不做（已知限制 7）
- 任何"用另一层机制替代门禁"的方案 —— 见 ADR-0003 宪法第 1 条

## 票与依赖

| 票 | 内容 | 依赖 | 写作用域 | 本票明确延后的文本 | 完成判据 |
|---|---|---|---|---|---|
| **#16** | 删门禁层：`guard.js`、`reservation.js`、mount 装配、16 个门禁 e2e | 无 | `host/mount.js`、`host/session.js`、`host/store.js`、`test/tasks.mjs`、`test/evidence.mjs`、`test/e2e/**` | `prompt.js`（#19） | 不存在任何工具调用前的拒绝路径；`npm test` 全绿 |
| **#17** | `model.js` 手术：执行账本 / 冲突 / 强制释放 / dispatch → `owner` 记录 + 一行 compare-and-set | #16 | `host/model.js`、`host/tools.js`、`host/mount.js`、`client.js`（只留 owner 显示）、`test/tasks.mjs`、`test/host-contract.mjs`、`package.json` | `prompt.js` 的完整改写（#19；本票只删除已失效的 op/字段描述）、`docs/CONTRACT.md`（#18） | 老 json 可读；二次 claim 被拒；**任何工具调用都不被拒** |
| **#18** | 删证据层：journal / reconcile / recovery / lifetime / team-lifetime / binding / roster / caller；CONTRACT 18→11 | #17 | 上述 8 个模块、`host/session.js`（承接 `callerOf`、删 `resolveSession`）、`host/tools.js`（改 import）、`host/store.js`、`docs/CONTRACT.md`、`GLOSSARY.md`（执行语汇标历史）、`test/modules.mjs`、`test/tasks.mjs`、`test/host-contract.mjs`（只确认、不改）、`package.json` | `README.md` / 需求 / `docs/implementation-status.md`（#19） | `grep execution host/` 只剩注释；契约与实现逐条一致；每个 `host/*.js` 可加载 |
| **#19** | 文档与提示词：`prompt.js` 改写、README 删「一次只做一件事」、需求 §10/§11 改记录语义、CHANGELOG `Removed`、版本 0.4.0 | #18 | `host/prompt.js`、`README.md`、`docs/requirements/REQUIREMENTS.md`、`docs/implementation-status.md`、`package.json`、`CHANGELOG.md` | — | README 不再描述任何强制行为；全仓无现行规则提及执行位 |
| **#20** | 验收：3 个 e2e（`tree-basics` / `acceptance` / **`no-gate`**）+ 手动验收 | #19 | `test/e2e/**`、`docs/testing/manual-acceptance.md` | — | 3 场景全绿；手动三条通过 |

## 为什么必须串行（而不是并行）

- **#17 必须在 #16 之后**：门禁还在时让 model 停止写执行记录，会让所有 A 类工具被永久拒绝（读不到 active 执行 = 一直拒），仓库会停在一个全红的状态。
- **#18 必须在 #17 之后**：`reconcile` / `lifetime` 读的正是 #17 里被删掉的那几处镜像；顺序反了，它们会对着空结构做对账。
- **#19 在 #18 之后**：CHANGELOG 要写"删了哪一层"，得等删除真的落地才知道最终数字。
- **#20 最后**：它是验收，不是实现。

## 实施时的环境要求

- **Agent Team 可选。** 门禁在 #16 已删除，没有成员上限，也不需要为了"能 claim"而避开团队模式；只在确实要并行读或分工时使用，写作用域仍按票面的文件所有权切分。
- 插件**可以开着**：现在它只是面板与两个任务树工具，不拦任何调用。
- 每张票一个会话，票自带上下文；不要靠上一张票的对话记忆。
- 实施后用两个只读 reviewer 做 **Standards / Spec 两轴 review**（`/code-review` 技能），不要实现者自评；机械性规则优先落成检查（见 `test/host-contract.mjs`）。

## 每张票的通用验收

1. `npm test` 全绿。
2. 已删除的行为**不留半成品**：不留 `if (false)`、不留注释掉的代码、不留 deprecated 但仍在执行的路径。
3. 注释与规则同一 commit 变更（`CODING_STANDARDS.md` 已有此规矩）。
4. 改动不夹带：每张票只碰它写作用域里的文件。
5. 机械性规矩优先落成检查，不写成散文：`test/host-contract.mjs` 守住「模型可见文本 / `client.js` ↔ 活着的 op 与字段」的一致性；`test/modules.mjs` 守住「每个 `host/*.js` 可加载」；`test/docs-contract.mjs` 守住「契约的 op 列表、模块引用、已删 surface」与代码一致。
6. 验收判据必须能在**开工时**一条命令跑出来。判据引用前一张票的产物时，开工第一件事是把判据跑一遍，红了就当场把判据改准并在同一个 commit 里说明。反例：#18 的 `grep -rn "execution" host/` 判据在 #17 保留 `executionApproval` 之后就永远不可能字面成立，收口见 #19。

## 回滚

- 四个 commit 顺序与票一致，`git revert` 从 #20 往回退即可恢复 0.3.7 行为（数据没有迁移，老 json 两种版本都能读）。
- **不要**为了回滚去改数据文件。
