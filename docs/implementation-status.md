# 实现现状（v0.4.0）

> 给 agent 与协作者的项目快照。改动后请同步本文件，否则它会比代码更旧。
> 最后核对：2026-11-09，`npm test` 全绿；`npm run test:e2e` 2 个场景通过（#20 整理成 3 个验收场景）。

## 版本与运行环境

| 项 | 值 |
|---|---|
| 包名 | `@mchenziyi/dsh-summary-panel`（展示名 DSH Reins / 缰绳） |
| 版本 | 0.4.0 |
| 运行环境 | DSH ≥ 0.2.0-rc.2，作为 Cordis bundle 以 `link:` 装进 profile |
| 技术标识 | 技术名保持不变，只有展示名是 Reins |
| 本版主题 | 拆除 0.3.7 之后的执行强制层（ADR-0003）：面板只展示 Agent 维护的任务树，不拦任何工具调用 |

## 模块地图

**Host 半**（DSH 主进程）

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：原有只读路由（git / outputs / diff / subagents / sources / context），再挂载任务树 |
| `host/mount.js` | 任务树的装配点；任一部分失败只降级该功能，不拖垮插件 |
| `host/model.js` | 纯域逻辑：`applyOps` 的 13 个 op、状态与父子树规则、`settled` 派生、授权与验收引用校验、领取记录的 compare-and-set、归档/恢复、两种快照（工具 payload 与 HTTP payload） |
| `host/tools.js` | `task_tree_read` / `task_tree_write` 两个模型工具（普通 ToolDefinition，不依赖 `@deepseek-ai/*`）；参数校验在 `host/model.js` |
| `host/store.js` | 每工作线一个 JSON；tmp+rename 原子写、per-workline 串行链、`.corrupt-<ts>` 隔离 |
| `host/routes.js` | `GET /summary-panel/tasks`、`GET /summary-panel/tasks/status`（只读） |
| `host/session.js` | 调用者身份 `callerOf`、工作线解析（沿 `parentSession` 上溯 ≤50 层）、会话存活判断 |
| `host/evidence.js` | 真实用户消息识别与引用校验（`approvalBasis` / `confirmationBasis` / `acceptanceBasis` / 变更交付时的 `userBasis`） |
| `host/prompt.js` | 系统提示词段落与两档提醒（有树 / 无树）：动手前写树、保持进展与下一步最新 |

**Client 半**（浏览器）

| 文件 | 职责 |
|---|---|
| `client.js` | 面板 store、入口呼吸灯、任务树分区、详情浮层（含领取记录与在线状态）、右栏 tab、轮询与取消 |

**存储**：`$DSH_PROFILE_DIR/agent-task-tree/<worklineId>.json`，一个工作线一份。老记录里已拆除的 `executions` / `workers` / `conflicts` / `owner.executionId` 读取时忽略，下一次写入自然消失（不迁移、不重写）。

## 任务树（v0.4.0 的边界）

- **没有工具前门禁**：任何工具调用都不需要先建树、先 claim；ADR-0003 的宪法规则是"不在工具运行前拒绝任何调用"。
- **`owner` 是记录，不是凭证**：`claim` 写下"这个会话在做"，`release` / 完成 / 暂缓 / 归档清空它；唯一的机械规则是一次 compare-and-set（同一任务同一时刻只允许一个会话持有），第二个会话的 claim 被拒。它不授予、也不收回任何权限。
- **仍然校验的是写入内容**，不是调用权限：未授权的任务不能变 `in_progress`；授权与验收原话必须能在真实用户消息里核对；父任务有未完成子任务时不能完成；已授权未完成的交付要暂缓/归档必须带用户原话。
- **维护规范只有提示词**：`host/prompt.js` 的段落与两档提醒是唯一入口；"只由 Lead 维护"是约定，工具对 teammate 与 subagent 同样开放。
- **面板如实显示**：领取记录（谁在做、那个会话是否还活着）、焦点、进展、下一步、结果、待授权、归档；记录为空或过期时，面板就空着或旧着。

## 已交付能力

- 任务树：层级、状态（pending / in_progress / blocked / done）、焦点、进展与结果、`expectedOutcome` / `nextStep`
- 生命周期：授权 `approved|pending`、需用户验收 `requiresUserAcceptance`、自验与用户验收分离、一句话只关闭一个任务
- 完成判定：父任务只有整棵活动子树完成才算完成，`settled` 派生（已完成父任务新增未完成子任务时重新显示未结算，历史验收记录不重写）
- 记录：`claim` / `release` 的领取记录与一次 compare-and-set；完成 / 暂缓 / 归档清空记录
- 归档：递归归档（同一批次）、恢复、归档历史与按需查询（`includeArchived`）
- 协作：Lead 维护树是约定；多个会话可同时工作，面板据此显示各自记录
- 界面：悬浮面板、入口呼吸灯、右栏任务详情 tab、行旁浮层、跟随主视图会话、中文 / English

## 测试

`npm test` 串行跑七份，全部是自建 harness，不依赖 DSH 运行时：

| 文件 | 覆盖 |
|---|---|
| `test/isolation.mjs` | harness 卫生：git 必须走隔离 helper；每个顶层 harness 都必须接进 `package.json` 脚本 |
| `test/modules.mjs` | 逐个 `import()` `host/*.js`，发布目录里每个模块都可加载 |
| `test/docs-contract.mjs` | 契约 op 列表 = `TASK_OPS`；文档点名的 `host/*.js` 必须存在；已删 surface 不得写成现行规则；用户可见文档不得再描述门禁语汇 |
| `test/host-contract.mjs` | 模型可见文本 / `client.js` 与活着的 op、字段一致；`host/` 源码里 `execution` 只允许出现在注释与保留字段 `executionApproval` 中 |
| `test/host.mjs` | 只读路由、git 解析、来源聚合、子智能体列表、会话上下文 |
| `test/tasks.mjs` | 域逻辑与工具 schema（含真实注册 schema 的校验）、store、领取记录与 compare-and-set、授权/验收引用、归档、临时任务、提示词契约 |
| `test/client.mjs` | React harness：hook 顺序检测、effect cleanup、多会话载荷、可挂起响应 |

### 真实进程验收（`npm run test:e2e`）

`npm run test:e2e` 在一次性 profile 里启动真实 `dsh` 进程（真实 Agent 循环、真实工具注册表），只把模型换成脚本适配器。断言的是工具调用的真实返回与磁盘上的任务树。

- 当前 2 个场景：`baseline-write`（无树时 `write` 依然成功——门禁不许回来）、`tree-init`（脚本化 `init` 后落盘的树）。`npm run test:e2e -- --list` 列出全部，`-- <name>` 只跑一个。
- #20 把它们整理成 3 个验收场景（`tree-basics`、`acceptance`、`no-gate`），总数仍是 3。
- 装置说明见 `test/e2e/README.md`；模型是脚本化的，场景只能看到脚本发出的调用。

## 已知限制

1. **验收引用是逐字比对，不是语义理解**：用户换一种说法就无法作为依据。
2. **`settled` 是派生字段**：外部消费者必须读 `settled`，不能只看 `status === 'done'`。
3. **旧记录兼容**：缺少 `executionApproval` / `requiresUserAcceptance` 的历史数据按位置补默认值；已拆除的账本字段读取时忽略。
4. **改 Host 代码后必须重载插件**：否则运行中的进程仍用旧构建（`cordis.patch.yml` 加/删注释触发重载，约 10 秒）。这是本项目最容易误判为"逻辑 bug"的坑。
5. **没有重组历史的功能**：`move` 有守卫且不鼓励，树的形态是只增不改的。
6. **没有任何强制机制**：记录是否准确完全取决于 Agent 是否照约定维护。它不写，面板就是空的；它写旧了，看到的就是过时的进度。可卸载的插件也不构成安全边界——本版不做文件系统隔离，也不阻止两个会话真的同时改同一个文件。
7. **插件被禁用时**：任务树工具、提示词与面板一起消失，数据（`agent-task-tree/*.json`）保留。没有"强制力"跟着消失，因为它本来就没有。
8. **`ask_user_question` 卡片里的回答不算用户原话**：`approvalBasis` / `acceptanceBasis` / `confirmationBasis` 只认用户在聊天框里打出来的文本。
9. **e2e 覆盖有限**：当前 2 个场景（#20 补到 3 个验收场景）；模型是脚本化的，真实对话中的判断无法由它覆盖。

## 外部文档

| 文档 | 位置 | 说明 |
|---|---|---|
| 需求文档 | `docs/requirements/REQUIREMENTS.md` | 产品承诺：顶部一屏摘要（§1.3 不是目标 / §14 第一版明确不做）；契约只管接口，不决定产品做什么 |
| 实现契约 | `docs/CONTRACT.md` | Host/Client 接口约定（11 条不变量、13 个 op）；不决定产品做什么 |
| 拆除执行门禁的决策 | `docs/adr/0003-remove-the-execution-gate.md` | 已采纳：为什么拆除、拆成哪些票、保留什么、宪法规则（不在工具运行前拒绝任何调用） |
| 早期决策（被取代） | `docs/adr/0001-every-write-needs-an-execution.md` | 历史记录：门禁时代"任何改工作区都要 claim"的推理与那次真实事故 |
| 拆除 spec | `docs/specs/remove-execution-gate.md` | #16–#20 的切片、写作用域与每张票的验收 |
| 执行调度设计 v8（历史） | `docs/plans/archive/dsh-execution-scheduling-v8.md` | 已归档的历史设计，**不再实现任何一条**：执行门禁/账本/对账/终身绑定已按 ADR-0003 拆除 |
| 变更记录 | `CHANGELOG.md` | 每版做了什么（0.4.0 的 `### Removed` 记录了拆掉哪一层） |
| 真实进程 e2e | `test/e2e/README.md` | 场景清单、装置原理、如何运行与装置的边界 |

> 需求与契约两份文档都已在本仓库（需求 `docs/requirements/`、契约 `docs/CONTRACT.md`）；原桌面目录只留指向它们的存根。
