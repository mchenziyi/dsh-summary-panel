# 实现现状（v0.3.7）

> 给 agent 与协作者的项目快照。改动后请同步本文件，否则它会比代码更旧。
> 最后核对：2026-11-06，`npm test` 全绿，工作区干净。

## 版本与运行环境

| 项 | 值 |
|---|---|
| 包名 | `@mchenziyi/dsh-summary-panel`（展示名 DSH Reins / 缰绳） |
| 版本 | 0.3.7 |
| 运行环境 | DSH ≥ 0.2.0-rc.2，作为 Cordis bundle 以 `link:` 装进 profile |
| 技术标识 | 技术名保持不变，只有展示名是 Reins |

## 模块地图

**Host 半**（DSH 主进程）

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：6 个只读路由（git / outputs / diff / subagents / sources / context），再挂载任务树 |
| `host/mount.js` | 任务树的装配点；任一部分失败只降级该功能，不拖垮插件 |
| `host/model.js` | 纯域逻辑：`applyOps`、状态机、`assertDeliveryComplete`、`isSettled`、验收引用校验、`dispatch` 与团队认领绑定 `bindTeamClaim`；执行账本/Worker 台账/执行戳三处镜像的写入与结束（含 `executionId` 守卫）、执行生命周期 `active/cold/orphaned/ended`、强制释放的纯判定 `forceReleaseReadiness`、中断证据 `markInterrupted`，以及 `workline.conflicts[]` 冲突记录 |
| `host/tools.js` | `task_tree_read` / `task_tree_write` 两个模型工具（普通 ToolDefinition，不依赖 `@deepseek-ai/*`） |
| `host/guard.js` | 执行门禁：A/B/C 三类工具分类（默认拒绝）与 `ctx.tools.guard` 单调守卫；身份取活 Agent，任务树走同步快照；只有账本里 `active` 的执行放行，`orphaned`（失联）明确拒绝并给出 Lead 强制释放路径；团队认领预检（含冲突停摆，先于 dispatch 检查）与 `reassign` 拒绝；放行改变执行归属的调用前同步占位（团队树操作也占用 Board 任务键） |
| `host/reservation.js` | 并发占位：`wl:`/`wk:`/`tk:` 三把同步座位键、只在 `tools/result` 或 Agent 转 `idle` 时释放、TTL 只标 `suspect` 不释放、进程内索引 |
| `host/binding.js` | 团队认领绑定：`tools/post-execute` 观察真实 Board 返回值，经 roster 解析身份后原子写入执行账本（账本行带 Registry `requestId`） |
| `host/journal.js` | 认领意图日志：`fsync` 追加 `<workline>.claims.jsonl`，读取与未结意图计算；索引而非真相，丢了只会减少权限 |
| `host/reconcile.js` | 认领证据与崩溃对账：每工作线启动后首次调用前收敛一次（解析执行者会话 → 标记/恢复执行状态 → Board 先行 → 账本重建/结束执行/清戳），矛盾只记冲突；不可解析的执行者标为 `orphaned` 但保留执行与任务；认领前写意图、提交后结算 |
| `host/recovery.js` | 中断证据：观察成功的 `interrupt_agent`，按 roster 名字或 `agent_id` 解析目标会话，把 `interruptedAt` 记到该会话未终结的执行上；只是强制释放的前置条件，不是结束证据 |
| `host/roster.js` | Team roster 身份解析的唯一实现（guard / binding / team-lifetime / reconcile 共用），身份只取活 Agent |
| `host/prompt.js` | 系统提示词段落与两档提醒（START / 每轮） |
| `host/store.js` | 每工作线一个 JSON；tmp+rename 原子写、per-workline 串行链、`.corrupt-<ts>` 隔离 |
| `host/evidence.js` | 真实用户消息识别与引用校验 |
| `host/session.js` | 工作线解析（沿 `parentSession` 上溯 ≤50 层）、会话存活判断、执行者三态解析 `resolveSession`（活/可恢复/不可解析） |
| `host/routes.js` | `GET /summary-panel/tasks`、`GET /summary-panel/tasks/status` |

**Client 半**（浏览器）

| 文件 | 职责 |
|---|---|
| `client.js` | 面板 store、入口呼吸灯、任务树分区、详情浮层（含执行者名称）、右栏 tab、轮询与取消 |

**存储**：`$DSH_PROFILE_DIR/agent-task-tree/<worklineId>.json`，一个工作线一份。

## 已交付能力

- 任务树：层级、状态（pending / in_progress / blocked / done）、焦点、进展与结果
- 生命周期：执行授权 `approved|pending`、需用户验收 `requiresUserAcceptance`、自验与用户验收分离
- 完成判定：父任务只有整棵活动子树完成才算完成，`settled` 派生
- 归档：归档 / 恢复 / 归档批次 / 归档查询（`includeArchived`）
- 协作边界：只有 Lead 维护任务树；标准模式下的子代理只能 `claim`/`release` 分配给自己的任务，team 模式下 teammate 仍不能写树
- 执行门禁（标准模式）：A 类工具（改工作区 / 跑代码）必须持有该工作线的活动执行；`claim` 建立、`release` 结束，两者与其余任务管理工具都是 B 类，不需要执行权；只读工具永远放行；未建任务树的工作线不受约束
- 单执行位与交接（标准模式）：整条工作线只有一个执行位，`executions[]` + `task.owner.executionId` 与树同一次落盘；`assign` 只做路由；交接按 Lead release → assign 子代理 → 子代理 claim/release → assign "lead" + claim 闭环，执行号单调递增且终态不可复活
- 团队模式 Lead 只协调：Agent Team 服务被组合即为团队模式；Lead 的 A 类工具（写文件、`edit`、shell、`terminal_*`、worktree、`workflow`、`ralph`、子代理派生）在执行之前一律被拒；`spawn_teammate`/消息/等待/列成员/两个任务系统/只读工具照常，任务树仍归 Lead 维护、teammate 不能写树；团队模式下 Lead 不能再用树 `claim` 建立执行
- 并发占位：改变执行归属的调用（树 `claim`/`release`/`complete`，Board `claim`/`release`/`complete`/`reopen`）在 guard 放行前同步占位，第二个在途认领立刻被拒；座位按标准模式工作线、执行者、任务三个维度取键（团队模式不取工作线，Worker 可并行）；只有真实调用已结束证据（匹配的 `tools/result`，或持位 Agent 转 `idle`）才释放，计时器只标记 `suspect` 并继续拒绝、绝不释放
- 团队模式认领绑定（claim-first）：Lead 用 `dispatch` 写路由；被指名的 Worker 自己认领 Team Board 任务；Host 在 Board 提交后用 roster 解析真实会话 id 并原子建立执行（`in_progress` + 执行戳 + `mode:"team"` 账本），此后该 Worker 才能改工作区；未绑定的 Worker 被拒，同一任务/同一会话最多一条非终态执行；Host 直接拒绝 `reassign`；执行者通过 `executor` 字段与面板显示
- 执行证据与崩溃对账：只有认领证据才建立执行（`dispatch` 与 Board 的 owner 单独都不算）；团队模式 Board 先行、账本后写，认领前 `fsync` 认领意图；重启后三处镜像（执行账本、Worker 台账、任务执行戳）收敛为一致状态且不会误清更新一轮；证据矛盾只记 `workline.conflicts[]` 并拒绝该任务的新认领，不猜执行者、不复活已结束执行
- 失联与强制终止：执行有 `active/cold/orphaned/ended` 四态，只有 `active` 授予 A 类权限；执行者会话无法解析时执行标为 `orphaned`（面板显示"执行者已失联"），执行戳与 Board 归属保留、绝不悄悄释放或改派；Lead 只有在 Host 记过中断、且运行时证明该 Worker 不在运行后才能 `release {force:true}`，随后结束执行（`force-terminated`）、结束其终身台账、清空执行戳并释放 Board；被终止的 Worker 再写文件被拒，新 Worker 重新认领得到新执行号。两轮之间的正常空闲仍视为 `active`
- 界面：悬浮面板、入口呼吸灯、右栏任务详情 tab、行旁浮层、跟随主视图会话

## 测试

`npm test` 串行跑四份，全部是自建 harness，不依赖 DSH 运行时：

| 文件 | 覆盖 |
|---|---|
| `test/host.mjs` | 只读路由、git 解析、来源聚合、子智能体列表、会话上下文 |
| `test/tasks.mjs` | 域逻辑与工具 schema（含真实注册 schema 的子集校验）、store 同步快照、执行门禁分类与三类授权、单执行位/交接/执行账本、`dispatch`/团队认领绑定、并发占位（三把键、TTL 只标可疑、E1/E2 释放、guard 预占） |
| `test/evidence.mjs` | 认领意图日志（fsync、撕裂尾行、结算）、崩溃收敛（三件套重建/陈旧意图/矛盾冲突/已完成任务结束执行）、`executionId` 守卫不清新一轮、冲突阻止 claim 与 guard 拒绝；执行生命周期（失联标记与恢复、空闲不误判）、中断证据与强制释放（运行中/未中断/非 Lead 被拒，成功后三处镜像与门禁拒绝） |
| `test/client.mjs` | React harness：hook 顺序检测、effect cleanup、多会话载荷、可挂起响应 |

## 已知限制

1. **验收引用是逐字比对，不是语义理解**：用户换一种说法就无法作为依据。
2. **`settled` 是派生字段**：外部消费者必须读 `settled`，不能只看 `status === 'done'`。
3. **旧记录兼容**：缺少 `executionApproval` / `requiresUserAcceptance` 的历史数据按位置补默认值。
4. **改 Host 代码后必须重载插件**：否则运行中的进程仍用旧构建（`cordis.patch.yml` 加/删注释触发重载，约 10 秒）。这是本项目最容易误判为"逻辑 bug"的坑。
5. **没有重组历史的功能**：`move` 有守卫且不鼓励，树的形态是只增不改的。

## 外部文档

| 文档 | 位置 | 说明 |
|---|---|---|
| 需求文档 | `~/Desktop/AI-TodoList/REQUIREMENTS.md` | 已冻结的 MVP 需求 |
| 实现契约 | `~/Desktop/AI-TodoList/CONTRACT.md` | Host/Client 唯一接口约定；与需求冲突以它为准 |
| 执行调度设计 v8 | `docs/plans/dsh-execution-scheduling-v8.md` | 已冻结；已实现标准模式的执行门禁（#3）、单执行位/交接（#4）、团队模式 Lead 只协调（#5）、认领绑定（#6）、成员终身绑定（#7）、执行证据与崩溃对账（#8）、并发占位（#9）与失联/强制终止（#10）切片 |
| 变更记录 | `CHANGELOG.md` | 每版做了什么 |

> 需求与契约两份文档仍在 `Desktop/AI-TodoList`，不在本仓库——agent 读仓库时看不到它们。是否迁入仓库尚未决定。
