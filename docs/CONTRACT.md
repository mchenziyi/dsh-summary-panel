# 任务树实现契约（Host / Client 共享）

需求来源：`~/Desktop/AI-TodoList/REQUIREMENTS.md`（已冻结）。
本文件是并行的唯一接口约定；两者冲突时以本文件为准，改动须先经 Lead。
本文件于 2026-11-06 从 `~/Desktop/AI-TodoList/CONTRACT.md` 迁入本仓库，此处为唯一维护位置；旧路径保留为指向本文的存根。

## 0. 范围与文件所有权

仓库：`/Users/czy/.dsh/bot/workspace/summary-panel`（git，v0.2.0，已以 link 方式装在 desktop profile）。

| 文件 | 所有者 | 说明 |
|---|---|---|
| `index.js` | host-core | Host 半：保留现有 5 个只读路由，新增任务树存储、工具、提示词、路由 |
| `host/*.js` | host-core | 新增模块（纯逻辑 / 域 / 工具 / 路由），可自建 |
| `test/tasks.mjs` | host-core | 新增单测（node 直接跑，不依赖 dsh） |
| `client.js` | client-ui | Client 半：面板行为、任务树分区、入口呼吸灯、右栏详情 tab |
| `package.json`、`locale/*.json`、`README.md`、`CHANGELOG.md` | Lead | 依赖、发布元数据、文档 |
| profile 配置与重载验证 | Lead | 其他人不得改 profile |

约束：不新增第三方依赖（`zod` 与 `@deepseek-ai/dsh-storage-domain` 由 dsh 解析，Lead 会在 package.json 声明）；无构建步骤；保持 ESM、2 空格缩进、单引号、现有注释风格；不得破坏 Git / 输出内容 / 子智能体 / 来源四个既有分区。

## 1. 数据模型

存储：**自建文件存储（零依赖，node:fs）**，host-core 实现 `host/store.js`。

- 目录：`$DSH_PROFILE_DIR/agent-task-tree/`，未设置时回退 `~/.dsh/agent-task-tree/`。
- 每个工作线一个文件 `<worklineId>.json`，内容 `{ version: 1, workline, tasks }`。
- 进程内 Map 缓存；同一工作线的写入串行化（promise 链）。
- 写盘用「临时文件 + rename」原子替换；文件损坏时改名为 `.corrupt-<ts>` 并当作空工作线，日志告警，不静默删除。
- 不得直接使用 `ctx.storageDomain`：dsh 包在该插件的解析路径上版本不一致，导入有风险。

工作线 id = **根会话 id**（沿 `SessionHeader.parentSession` 递归到顶，最多 50 层，取不到 header 就停在当前会话）。分支、子会话都归到同一工作线。

```ts
WorklineRecord = {
  id: string
  createdAt: number          // ms
  updatedAt: number
  goal: {
    original: string         // 创建后只读
    current: string          // 默认等于 original
    changes: { at: number, reason: string, previous: string, next: string }[]
  }
  outline: string            // 目标大纲，自由文本，可空
  focus: string[]            // 当前执行焦点的 taskId，可多个，按设置顺序
  nextSeq: number            // 生成 t1/t2/... 用
}

TaskRecord = {
  id: string                 // 't1'、't2'...
  worklineId: string
  parentId: string | null
  order: number              // 同级排序，升序
  title: string              // 简短名，1..40 字符，单行
  summary: string            // 悬停简介，0..240 字符，单行
  status: 'pending' | 'in_progress' | 'blocked' | 'done'
  deferred: boolean
  deferredReason?: string
  resumeCondition?: string
  archived: boolean
  archiveReason?: string
  archivedAt?: number
  progress: string           // 进展记录，可多段，<= 2000 字符
  result?: string            // 完成结果，<= 500 字符
  blocker?: { reason: string, unblock: string } | null
  assignee?: 'lead' | string | null // 标准模式：本任务被分配给哪个会话（仅路由）
  owner?: { sessionId: string, executionId: string, since: number } | null   // 当前执行占用
  completion?: 'user-confirmed' | 'self'
  completedAt?: number
  createdAt: number
  updatedAt: number
}
```

## 2. 不变量（Host 端强制，客户端只展示）

1. `title` 去空白后非空、≤40 字、单行；`summary` ≤240 字。
2. `parentId` 必须存在、同工作线、未归档；不能成环（不能把父改成自己的后代）。
3. 父任务还有未完成、未归档的子任务时，**不能**标 `done`。
4. 任务标 `done` 时：清空 `blocker`、释放 `owner`、从 `focus` 移除、写 `completedAt`。
5. `deferred` 是标记而非状态：不改 `status`、不重置进度；暂缓任务不能有焦点、不能被领取。
6. `archived` 任务从活跃树移除，其整棵子树一并归档；已归档任务仍有子任务未归档视为数据错误（应用归档时递归）。
7. `focus` 中的任务必须未归档、未暂缓；设置焦点时若状态为 `pending` 则改为 `in_progress`；移除焦点不改变状态。
8. 领取（claim）要求任务未归档、未暂缓、状态为 `in_progress`、已执行授权；标准模式下整条工作线只有一个执行位，任何非终态执行存在时其他认领一律拒绝（含 Lead 换任务、子代理认领、已死会话占位）；只有持位者能 `release`/`complete` 自己的执行。分配（assign）不是认领，不产生执行。
9. 目标：`original` 只能写一次；`reviseGoal` 必须带 `reason`，追写 `changes`，并把 `current` 改为新值（调用方已向用户确认）。
10. 工具写操作：调用者 `header.origin === 'subagent'` 时拒绝（团队 Teammate 也是 subagent）；若 `agentTeams.membership(agent).role === 'teammate'` 也拒绝。读操作不限制。

## 3. Agent 工具（Host 注册，模型可见）

两个工具，均自动定位调用者的工作线。

### `task_tree_read`

参数：`{ details?: boolean }`（`details=true` 时额外返回 summary/progress/result）。

输出（JSON，`additionalProperties:false`）：

```
{ worklineId, goal: { original, current }, focus: string[],
  tasks: [{ id, parentId, title, status, deferred, blocked: boolean,
            owner: boolean, depth, summary?, progress?, result? }] }
```

说明：按树序返回（父在前，同级按 order）；`depth` 由 Host 计算；未建树时返回 `worklineId` + 空 `tasks` + `goal` 为 null。

### `task_tree_write`

参数：`{ ops: Op[] }`，`Op` 是扁平对象（避免嵌套 union，所有字段可选）：

```
{
  op: 'init'|'reviseGoal'|'create'|'update'|'move'|'defer'|'resume'|
      'archive'|'focus'|'assign'|'claim'|'release'|'complete'
  id?: string
  parentId?: string | null
  ids?: string[]
  member?: string           // assign：子会话 id 或 "lead"（仅标准模式 Lead）
  title?: string
  summary?: string
  outline?: string
  current?: string          // reviseGoal
  reason?: string           // reviseGoal / archive
  status?: 'pending'|'in_progress'|'blocked'|'done'
  progress?: string
  result?: string
  blockerReason?: string
  blockerUnblock?: string
  deferredReason?: string
  resumeCondition?: string
  order?: number
  confirmedByUser?: boolean // complete 必填 true 表示用户已确认
  originalGoal?: string     // init
}
```

行为：

- `init`：工作线不存在时创建，写 `originalGoal`/`outline`；已存在则报错（不要覆盖）。
- `create`：新建子任务，`parentId` 省略为顶层；返回新 id（`t1`…）。同级 order 默认追加。
- `update`：局部更新 title/summary/status/progress/result/blocker（blocker 用两个字段，至少给 reason；两者都空表示清除）。
- `move`：改 parentId / order；校验成环。
- `defer` / `resume`：见不变量 5。
- `archive`：递归归档子树，清焦点与占用。
- `focus`：**整体替换**焦点集合（`ids: []` 表示清空）。
- `assign`：标准模式 Lead 把任务路由给子会话或收回给自己；只能在没有活动执行时分配，分配本身不产生执行。
- `claim` / `release`：执行占用。标准模式下全工作线只有一个执行位；每次 claim 分配新的单调 `executionId`，结束的执行只追加终态，不复活。
- `complete`：等价 `update status='done'`，但必须 `confirmedByUser: true`；校验子任务；写 `completion='user-confirmed'`。
- 一次调用内先全量校验再写入；返回 `{ ok: true, worklineId, applied: [{op, id?}] }` 或抛出可读错误（含任务 id 与原因）。

工具描述（description）必须写清：何时读、何时写、短标题、不为琐碎修复建节点、完成前询问用户、目标修订需确认、只 Lead 维护。

## 4. HTTP API（Host，Client 只读消费）

全部沿用现有约定：`GET`、经 `connection.requestRejection` 信任围栏、`cache-control: no-store`、`sessionId` 必填。

### `GET /summary-panel/tasks?sessionId=…`

```json
{
  "available": true,
  "worklineId": "session-…",
  "goal": { "original": "…", "current": "…", "changes": [{ "at": 0, "reason": "…", "previous": "…", "next": "…" }] },
  "outline": "…",
  "focus": ["t3"],
  "updatedAt": 0,
  "tasks": [
    { "id": "t1", "parentId": null, "order": 0, "title": "用户登录",
      "summary": "…", "status": "in_progress", "deferred": false,
      "deferredReason": null, "resumeCondition": null,
      "blocker": null, "progress": "…", "result": null,
      "ownerSessionId": "session-…", "ownerLive": true,
      "completion": null, "updatedAt": 0 }
  ],
  "archived": [
    { "id": "t9", "parentId": null, "title": "短信登录", "archiveReason": "…", "archivedAt": 0 }
  ],
  "archivedCount": 1
}
```

- 只返回未归档任务的完整数据；`archived` 最多 200 条（按 archivedAt 倒序）。
- 没有建树时：`available: true`，`goal: null`，`tasks: []`，`focus: []`。
- 存储不可用时：`{ "available": false, "reason": "no-storage" }`；会话未知：现有路由行为（404）。

### `GET /summary-panel/tasks/status?sessionId=…`

```json
{ "available": true, "focus": [{ "id": "t3", "title": "…", "status": "in_progress", "blocked": false }], "updatedAt": 0 }
```

供入口呼吸灯使用，负载保持小。

### 客户端刷新

v1 用轮询，不做 SSE：面板打开时任务树 1.5s、详情 tab 3s、入口状态 5s；打开面板时立即刷新一次。轮询必须可被组件卸载取消。

## 5. 客户端行为（client-ui）

### 5.1 面板行为

- 打开后**点击面板外部不关闭**（删除现有 outside-click 关闭逻辑）；Esc、关闭按钮、再点入口可关闭。
- 切换会话时面板不关闭，切换到新会话的任务树；新会话无树显示空态。
- 保持现有锚定、宽度 420、高度自适应、Escape 处理。

### 5.2 任务树分区

- 注册为内置分区，`order` 小于 Git（10），标题「当前任务」/「Tasks」。
- 每行：展开箭头（有子任务时）+ 状态点（8px 圆点）+ 简短标题。
- 状态色：待开始 `--dsw-alias-state-idle-primary`；进行中 `--dsw-alias-brand-primary`；阻塞 `--dsw-alias-state-warn-primary`；已完成 `--dsw-alias-state-success-primary`。
- 焦点任务：标题加粗 + 很淡的背景（如 `color-mix` 或低透明度 brand 底色），父任务不跟随；可多个。
- 默认收纳：仅展开焦点任务的祖先路径；无焦点时全部收起。用户手动展开的分支在轮询刷新时**不得**被收回；仅在会话切换时按默认重新初始化。
- 暂缓任务整行 `opacity: 0.55`。
- 悬停显示浮层：完整标题 + summary + 阻塞原因（阻塞时）；延迟 ≤300ms，随主题 token；不遮挡点击。
- 点击行打开右栏详情 tab；点箭头只展开/折叠。
- 空态：`available=false` 显示「任务树依赖的存储不可用」；无树显示「Agent 开始工作后会自动建立任务树」。
- 加载失败显示简短错误与重试，不影响其他分区。

### 5.3 入口呼吸灯

- 入口按钮内右下/右上角小点；`focus.length > 0` 时显示并 1.6s 呼吸（opacity 0.25↔1），颜色随首个焦点状态（进行中=brand，阻塞=warn），否则不显示。
- `prefers-reduced-motion: reduce` 时静态显示。
- 悬停入口 `title` 显示首个焦点任务名（沿用 t() 文案）。

### 5.4 右栏详情 tab

- 注册 tab 类型 `summary-panel.task` + `sidebar.right.pane.tab` 的 key，参数 `{ sessionId, taskId }`；打开前收起浮窗（沿用现有模式）。
- 内容只读：标题、状态文字、summary、进展、结果、阻塞原因、占用会话、完成方式；上方「目标」区块展示 original/current 与修订记录；底部「已归档 N」可展开查看归档列表（原因、时间）。
- 同一 tab 复用到不同任务（参照 diff tab 的复用逻辑：按 pane 去重 + 参数更新）。
- 任务在归档列表中也能打开（显示归档原因）。

### 5.5 本地化

所有新文案同时写 `ZH` 与 `EN`（沿用 client.js 现有字典），不得硬编码中文到 JSX 文本里。

## 6. 代码约束

- 现有 `apply(ctx)` 结构保留；Host 新代码尽量放在 `host/` 下，`index.js` 只做装配，避免单文件继续膨胀。
- **禁止在插件代码里 import `@deepseek-ai/*` 或 `zod`**：桌面端解析到的是另一份旧版本 dsh，会与运行中的宿主不匹配。任务树只用 Node 内置模块。
- 工具用普通对象注册（`ToolDefinition` 形状：`{ name, description, parameters(JSON Schema), output: { schema, render }, execute }`），不要 `defineTool`；参数校验由 `host/model.js` 自己做。
- 任何初始化失败（目录不可写等）都只能让任务特性降级（`available:false`），不得让整个插件加载失败。
- 所有路由沿用现有 `route()` 封装与信任围栏；新增路由路径不得与既有冲突。
- 域名与任务 id 不得含 `/`、`..`（per-record 文件路径要求 `[a-zA-Z0-9_-]+`；会话 id 形如 `session-<uuid>` 可用）。
- 写操作要 `updatedAt`、工作线 `updatedAt` 同步。
- 单测：`node test/host.mjs && node test/tasks.mjs`，纯逻辑不引入 dsh 依赖（`host/model.js` 不 import dsh/zod）。

## 7. 验收（Lead 集成时执行）

1. 两半通过语法检查：`node --check index.js`、`node --check client.js`。
2. `node test/host.mjs`、`node test/tasks.mjs` 全绿。
3. 契约字段一致（客户端读取的字段 = Host 返回的字段）。
4. 现有四个分区行为不变；插件加载无报错。
5. live 验证：工具出现在 Agent 工具列表、`/summary-panel/tasks` 返回预期 JSON、面板显示任务树、入口呼吸灯出现、点击打开右栏详情。
