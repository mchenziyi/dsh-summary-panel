# 迁移到 Windows（或任何新机器）

> 目标：在新机器上接着开发 DSH Reins。
> **顺序不能换：先技能、再仓库。** 先克隆仓库的人，打开新会话会发现没有 `/implement` —— 然后以为技能丢了。

## 四样东西，缺一样就卡住

| # | 东西 | 在旧机器的哪里 | 新机器怎么拿 |
|---|---|---|---|
| 1 | DSH + Node | 应用本身 | 装 DSH（≥ 0.2.0-rc.2）与 Node（pre-commit 会跑 `npm test`） |
| 2 | 插件本体（缰绳） | 市场，或 profile 里的 link | 市场装（`dist-tags.latest = 0.4.0`），或在 profile 里 link 克隆目录 |
| 3 | **matt 技能（38 个）** | `~/Desktop/AI-TodoList/.agents/` + `skills-lock.json`（**不在缰绳仓库里**） | 把整个 `.agents/` 目录与 `skills-lock.json` 拷过去，或按 lock 文件重装（来源 `mattpocock/skills`，带 hash） |
| 4 | 仓库 | GitHub | `git clone`，然后 `git config core.hooksPath .githooks` |

## 步骤

1. 装 DSH 与 Node。
2. `git clone git@github.com:mchenziyi/dsh-summary-panel.git && cd dsh-summary-panel`
3. `git config core.hooksPath .githooks` —— 每个克隆一次。hooks 是 `/bin/sh`，Git for Windows 自带。
4. 可选：`git checkout v0.4.0`（`main` 已包含该提交）。
5. **把旧机器的 `.agents/` 与 `skills-lock.json` 放到新机器的工作区根目录。** 没做这步，`/implement`、`/handoff`、`/ask-matt` 都不存在。
6. 装插件：市场（`latest = 0.4.0`），或在 DSH profile 里 link 第 2 步克隆出来的目录。
7. **在仓库目录里**开新会话（不是桌面工作区）。
8. 先读 `docs/progress/2026-11-09-handoff.md`，再读 `docs/requirements/REQUIREMENTS.md` 顶部那张一屏摘要。

**完成判据**：新会话里 `/ask-matt` 可用、任务树工具可用、`npm test` 全绿。

## 带不走的

- **任务树**：`~/.dsh/agent-task-tree/<根会话 id>.json`，按工作线存储。新机器 = 新会话 = **空面板**。这是预期，不是 bug。
- **会话历史**：`~/.dsh/sessions/`。
- 插件在 profile 里的 link 配置：需要重新 link 一次。

## 常见坑

- 先 clone 仓库、后装技能 → 新会话里没有 `/implement`，看起来像"技能丢了"。
- Windows 上不设 `core.hooksPath` → 提交会绕过 `npm test` 和"main 只能走 PR"两个守卫。
- 别指望 `git checkout v0.4.0` 带回任务树：tag 只包含代码与文档。
- 桌面工作区里的 `REQUIREMENTS.md` / `CONTRACT.md` 现在只是指向仓库的**存根**，别在那里改。
