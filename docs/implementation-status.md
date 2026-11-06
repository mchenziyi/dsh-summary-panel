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
| `host/model.js` | 纯域逻辑：`applyOps`、状态机、`assertDeliveryComplete`、`isSettled`、验收引用校验 |
| `host/tools.js` | `task_tree_read` / `task_tree_write` 两个模型工具（普通 ToolDefinition，不依赖 `@deepseek-ai/*`） |
| `host/guard.js` | 执行门禁：A/B/C 三类工具分类（默认拒绝）与 `ctx.tools.guard` 单调守卫；身份取活 Agent，任务树走同步快照 |
| `host/prompt.js` | 系统提示词段落与两档提醒（START / 每轮） |
| `host/store.js` | 每工作线一个 JSON；tmp+rename 原子写、per-workline 串行链、`.corrupt-<ts>` 隔离 |
| `host/evidence.js` | 真实用户消息识别与引用校验 |
| `host/session.js` | 工作线解析（沿 `parentSession` 上溯 ≤50 层）、会话存活判断 |
| `host/routes.js` | `GET /summary-panel/tasks`、`GET /summary-panel/tasks/status` |

**Client 半**（浏览器）

| 文件 | 职责 |
|---|---|
| `client.js` | 面板 store、入口呼吸灯、任务树分区、详情浮层、右栏 tab、轮询与取消 |

**存储**：`$DSH_PROFILE_DIR/agent-task-tree/<worklineId>.json`，一个工作线一份。

## 已交付能力

- 任务树：层级、状态（pending / in_progress / blocked / done）、焦点、进展与结果
- 生命周期：执行授权 `approved|pending`、需用户验收 `requiresUserAcceptance`、自验与用户验收分离
- 完成判定：父任务只有整棵活动子树完成才算完成，`settled` 派生
- 归档：归档 / 恢复 / 归档批次 / 归档查询（`includeArchived`）
- 协作边界：只有 Lead 维护任务树；标准模式下的子代理只能 `claim`/`release` 分配给自己的任务，team 模式下 teammate 仍不能写树
- 执行门禁（标准模式）：A 类工具（改工作区 / 跑代码）必须持有该工作线的活动执行；`claim` 建立、`release` 结束，两者与其余任务管理工具都是 B 类，不需要执行权；只读工具永远放行；未建任务树的工作线不受约束
- 单执行位与交接（标准模式）：整条工作线只有一个执行位，`executions[]` + `task.owner.executionId` 与树同一次落盘；`assign` 只做路由；交接按 Lead release → assign 子代理 → 子代理 claim/release → assign "lead" + claim 闭环，执行号单调递增且终态不可复活
- 界面：悬浮面板、入口呼吸灯、右栏任务详情 tab、行旁浮层、跟随主视图会话

## 测试

`npm test` 串行跑三份，全部是自建 harness，不依赖 DSH 运行时：

| 文件 | 覆盖 |
|---|---|
| `test/host.mjs` | 只读路由、git 解析、来源聚合、子智能体列表、会话上下文 |
| `test/tasks.mjs` | 域逻辑与工具 schema（含真实注册 schema 的子集校验）、store 同步快照、执行门禁分类与三类授权、单执行位/交接/执行账本 |
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
| 执行调度设计 v8 | `docs/plans/dsh-execution-scheduling-v8.md` | 已冻结；已实现标准模式的执行门禁（#3）与单执行位/交接（#4）切片 |
| 变更记录 | `CHANGELOG.md` | 每版做了什么 |

> 需求与契约两份文档仍在 `Desktop/AI-TodoList`，不在本仓库——agent 读仓库时看不到它们。是否迁入仓库尚未决定。
