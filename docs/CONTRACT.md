# 任务树实现契约（Host / Client 共享）

需求来源：`docs/requirements/REQUIREMENTS.md`（产品承诺，已迁入本仓库）。
本文件只管 Host/Client 接口；它不决定产品做什么。两者不重叠时各管一段，重叠处（接口）以本文件为准，改动须先经 Lead。
本文件于 2026-11-06 从原桌面目录的 `CONTRACT.md` 迁入本仓库，此处为唯一维护位置；原位置只留指向本文的存根。需求文档于 2026-11-09 迁入 `docs/requirements/REQUIREMENTS.md`，原位置同样只留指向它的存根。

## 0. 范围与文件所有权

仓库：本仓库根目录（git）。当前版本与安装方式见 `docs/implementation-status.md`。

| 文件 | 所有者 | 说明 |
|---|---|---|
| `index.js` | host-core | Host 半：保留现有 5 个只读路由，新增任务树存储、工具、提示词、路由 |
| `host/*.js` | host-core | 新增模块（纯逻辑 / 域 / 工具 / 路由），可自建 |
| `test/tasks.mjs` | host-core | 新增单测（node 直接跑，不依赖 dsh） |
| `test/modules.mjs` | host-core | 加载检查：逐个 `import()` `host/*.js`，发布的模块缺一不可加载 |
| `test/host-contract.mjs` | host-core | 机械检查：模型可见文本 / `client.js` 与活着的 op、字段一致 |
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
  // 以下字段自 v0.4.0 起不再写入（ADR-0003）：老记录里可能存在，读取时忽略，
  // 不迁移、不重写，下一次写入时自然消失。
  nextExecution?: number              // @deprecated 旧执行计数器
  executions?: ExecutionRecord[]      // @deprecated 旧执行账本
  workers?: Record<string, WorkerLifetime>   // @deprecated 旧 Worker 绑定表
  conflicts?: ConflictRecord[]        // @deprecated 旧证据冲突
}

TaskRecord = {
  id: string                 // 't1'、't2'...
  worklineId: string
  parentId: string | null
  order: number              // 同级排序，升序
  title: string              // 简短名，1..40 字符，单行
  summary: string            // 悬停简介，0..240 字符，单行
  expectedOutcome: string    // 预期结果，0..240 字符，单行；右栏展示
  nextStep: string           // 下一步，0..240 字符，单行；右栏展示
  temporary: boolean         // 是否为被紧急问题打断而插入的临时任务
  temporaryFor?: string | null // 被它打断的主线任务 id；temporary=true 时必须指向同工作线的活跃任务
  status: 'pending' | 'in_progress' | 'blocked' | 'done'
  deferred: boolean
  deferredReason?: string
  deferredBasis?: string | null   // defer 时记下的用户原话（改变交付时必需）
  resumeCondition?: string
  archived: boolean
  archiveReason?: string
  archivedAt?: number
  progress: string           // 进展记录，可多段，<= 2000 字符
  result?: string            // 完成结果，<= 500 字符
  blocker?: { reason: string, unblock: string } | null
  assignee?: 'lead' | string | null // @deprecated 自 v0.4.0 起不再写入，读取时忽略
  owner?: { sessionId: string, executionId?: string, member?: string | null, since: number } | null   // 当前领取记录（只是记录，不授权任何调用）；executionId 为 @deprecated 字段，自 v0.4.0 起不再写入、读取时忽略
  executionApproval: 'approved' | 'pending'   // 执行授权，与状态独立
  approvalBasis?: string | null     // 授权的用户原话
  approvalAt?: number               // 授权时刻（验收时用于拒绝早于授权的原话）
  requiresUserAcceptance: boolean   // 顶层任务默认 true，子步骤默认 false
  acceptanceBasis?: string | null   // 豁免验收时的用户原话
  completion?: 'user-confirmed' | 'self'
  completionBasis?: string | null
  completedAt?: number
  teamTaskId?: string | null        // @deprecated 自 v0.4.0 起不再写入，读取时忽略
  dispatch?: { member: string, at: number } | null   // @deprecated 自 v0.4.0 起不再写入，读取时忽略
  archiveBatch?: string | null
  archiveBasis?: string | null
  archiveHistory: { at: number, reason: string, basis?: string }[]
  createdAt: number
  updatedAt: number
}
```

以下三种记录属于已拆除的证据层（ADR-0003），自 v0.4.0 起既不再写入也不再被读取；保留结构定义只为说明老 json 里那些字段的形状。

```ts
// @deprecated v0.4.0：不再写入，读取时整段忽略
ExecutionRecord = {
  executionId: string         // 'ex-1'、'ex-2'…，单调、不重用
  taskId: string
  sessionId: string           // Host 解析出的执行者会话
  attempt: number
  mode: 'standard' | 'team'
  teamTaskId?: string | null
  member?: string | null      // 团队模式的成员名
  claimRevision?: number | null
  requestId?: string | null   // 旧字段：认领意图日志的 Registry callId
  rebuiltFrom?: string | null // 旧字段：仅重启后由日志重建时写入
  state: 'active' | 'orphaned' | 'ended'   // 旧执行状态；v0.4.0 起不再授予任何权限
  interruptedAt?: number | null            // 观测到的 interrupt_agent 时刻
  note?: string | null
  startedAt: number
  updatedAt: number
  endedAt?: number | null
  endReason?: string | null   // 旧终止原因（完成 / 释放 / 暂缓 / 归档 / 强制终止 / 对账）
}

// @deprecated v0.4.0：不再写入，读取时整段忽略
WorkerLifetime = {            // 旧字段：keyed by sessionId
  kind: 'teammate' | 'subagent' | null
  name?: string | null
  state: 'bound' | 'ended'    // 旧 Worker 绑定状态
  boundTaskId?: string | null
  executionId?: string | null
  createdAt: number
  updatedAt: number
  endedAt?: number | null
  endReason?: string | null
}

// @deprecated v0.4.0：不再写入，读取时整段忽略
ConflictRecord = {
  id: string                  // 'cf-1'、'cf-2'…
  scope: 'task' | 'workline'  // 旧字段：任务级 / 工作线级
  taskId: string | null       // workline 级为 null
  kind: 'unproven-claim' | 'claim-without-record' | 'ended-but-owned' | 'seat-ambiguous'
  evidence: object            // 观测到的证据，有界
  createdAt: number
  resolvedAt: number | null   // 旧冲突状态；v0.4.0 起不再停住任何 claim
  resolvedBy: string | null   // 旧字段：做出决定的 Lead 会话
  resolution: string | null   // 决定的原因
}
```

未知字段在读取时忽略。老记录里的 `executions` / `workers` / `conflicts` / `owner.executionId` / `assignee` / `dispatch` / `teamTaskId` 都属于这一类：不迁移、不重写，下一次写入时整段消失。工作线 id 与任务 id 的字符集不变（见 §6）。

## 2. 不变量（Host 端强制，客户端只展示）

Host 只在 `task_tree_write` 的写路径上、对本次要写入的数据执行下列 11 条规则。**没有任何工具调用会在执行前被拒绝**（ADR-0003 宪法第 1 条）：没有工具前的拦截、没有占用校验、没有证据对账，`owner` 是记录而不是凭证，`claim` / `release` 不授予也不收回任何权限。提示词与工具描述里的「只有 Lead 维护这棵树」是约定，不是代码规则。

1. **文本字段**：`title` 去空白后非空、≤40 字、单行；`summary`、`expectedOutcome`、`nextStep` 单行且 ≤240 字，`blockerReason`、`blockerUnblock` 单行且 ≤1000 字；`progress` ≤2000 字多行，`result` ≤500 字；`outline` ≤4000 字，`originalGoal` / `current` 单行 ≤4000 字，`reason` 单行 ≤1000 字；`deferredReason` / `resumeCondition` 单行 ≤500 字。`approvalBasis` / `acceptanceBasis` / `confirmationBasis` / `userBasis` 单行、≤200 字（走校验的路径另有 2 字下限）；前三者的用户原话校验见 9、10，`userBasis` 的校验见 4、5。空字符串表示未填写（`title` 除外）。
2. **树形**：`parentId` 必须指向同工作线、未归档的现有任务；不能把自己或自己的后代设为父（成环）；`order` 为非负整数，省略时追加到同级末尾；`move` 不能移动已开始且未完成的交付任务。`depth` 由 Host 按树序计算。
3. **完成**：父任务存在未完成、未归档的子任务时不能标 `done`（`pending` / `in_progress` / `blocked` 都算未完成；`deferred` 只是标记，暂缓中的未完成任务照样阻塞）；标 `done` 时清空 `blocker`、释放 `owner`、移出 `focus`，写 `completedAt` 与 `completion`。`settled` = 已完成且子树没有未完成项；已完成父任务后来新增未完成子任务时 `settled` 变回 `false`（面板显示未结算），但 `status` 仍是 `done`，完成/验收记录不重写。
4. **暂缓**：`deferred` 是标记而非状态，不改 `status`、不重置进度；未完成的任务暂缓后不能进入 `focus`、不能 `claim`、不能 `complete`（需先 `resume`），已完成任务暂缓只留标记；`resume` 只清标记与原因。暂缓一个已开始或已授权、且未完成的交付必须带 `userBasis`（真实用户原话），因为这是缩小当前交付；从未授权的想法与已完成的工作是普通整理，不需要。
5. **归档**：`archive` 把目标及其活跃子树整体归档（同一 `archiveBatch`），写 `archivedAt` / `archiveReason` / `archiveHistory`，并释放 `owner`、移出 `focus`；`restore` 保留原 id 与历史，回到仍活跃的最近祖先（原父已归档时重挂到更近的祖先或根），同一批归档的子树一起恢复。归档一个已开始或已授权、且未完成的交付（含其子树里任何这样的任务）同样必须带 `userBasis` 真实原话；归档是清空未完成交付的正当办法，不能靠 `move` 或 `defer` 假装完成。
6. **焦点**：`focus` 整体替换集合，成员必须存在、未归档、未暂缓、未 `done`；设置焦点时若成员为 `pending` 且已授权则改为 `in_progress`，移除焦点不改变状态；完成 / 暂缓 / 归档会自动把任务移出焦点。
7. **领取记录**：`claim` 要求任务活跃、未暂缓、`in_progress` 且已授权；同一时刻只有一个会话能持有同一任务，第二个会话的 `claim` 被拒（唯一保留的 compare-and-set，理由形如 `task t3 is already claimed by session …`），同会话重复 `claim` 只刷新记录；`release` 任何会话都可调用、不校验持有者；`complete` / `defer` / `archive` 清空记录。记录不授权任何工具调用。
8. **目标**：`original` 每个工作线只写一次（`init` 只能成功一次）；`reviseGoal` 必须带 `reason`，且 `current` 必须与现值不同，追写一条 `changes`。
9. **执行授权**：`executionApproval` ∈ { `approved`, `pending` }，与 `status` 独立；`pending` 任务不能变为 `in_progress` 或 `done`、不能 `claim`；显式 `approved` 必须带真实用户原话 `approvalBasis`（Host 在会话日志里核对），只有 `create` 在已批准的直接父任务下可以继承授权；已经开始的任务不能改回 `pending`。Agent 根据对话判断用户授权的范围。用户确认新方向并要求先规划时，Agent 更新目标，实施任务保持待授权。
10. **验收与完成**：`requiresUserAcceptance` 顶层默认 `true`、子任务默认 `false`；需要验收的任务不能由 agent 自行完成，只能在用户验收后以 `confirmedByUser: true` + `confirmationBasis` 完成，该原话必须晚于任务创建/授权，且同一句只能验收一个任务。Agent 根据对话确认用户接受的是哪项已交付任务，遇到歧义时先问清楚。豁免验收需 `acceptanceBasis` 真实原话。自行完成的实现步骤记 `completion: "self"`。
11. **临时任务**：`temporary` 为布尔；`temporaryFor` 必须指向同工作线、未归档且不是自己的现有任务，打断链不能成环；写非空 `temporaryFor` 会同时把任务标为 `temporary: true`，`temporary: false` 或 `temporaryFor: null` 清空链接，`temporary: true` 而没有来源则拒绝。

## 3. Agent 工具（Host 注册，模型可见）

两个工具，均自动定位调用者的工作线；调用者身份取自活 Agent 的 session header（`host/session.js` 的 `callerOf`），从不读模型输入。

### `task_tree_read`

参数：`{ details?: boolean, includeArchived?: boolean, archivedLimit?: number }`
（`details=true` 时额外返回 summary/expectedOutcome/nextStep/progress/result/completion/approvalBasis/acceptanceBasis；
`includeArchived=true` 时额外返回 `archived` 与 `archivedTotal`，`archivedLimit` 1..200，默认 50）。

输出（JSON，`additionalProperties:false`，未声明的字段会被宿主拒绝）：

```
{ worklineId, goal: { original, current } | null, focus: string[],
  tasks: [{ id, parentId, title, status, settled, approval, requiresUserAcceptance,
            deferred, blocked, owner: boolean,
            executor: { kind: 'lead'|'teammate'|'subagent', name, sessionId } | null,
            temporary: boolean, temporaryFor: string | null,
            depth, summary?, expectedOutcome?, nextStep?, progress?, result?, completion?, approvalBasis?, acceptanceBasis? }],
  archived?: [{ id, parentId, title, status, approval, deferred, archivedAt,
                archiveReason, summary, progress, result, completion, path }],
  archivedTotal?: number }
```

说明：按树序返回（父在前，同级按 order）；`depth` 由 Host 计算；未建树时返回 `worklineId` + `goal:null` + 空 `focus` / `tasks`。`executor` 是任务上的领取记录（最近一次声称「我在做」的会话：Lead / 具名 teammate / subagent），只是面板显示用的名字，不是权限。`settled`、`approval`、`requiresUserAcceptance` 与 `blocked` 都是派生值（见 §2）。

### `task_tree_write`

参数：`{ ops: Op[] }`，`Op` 是扁平对象（避免嵌套 union，所有字段可选）：

```
{
  op: 'init'|'reviseGoal'|'create'|'update'|'move'|'defer'|'resume'|
      'archive'|'restore'|'focus'|'claim'|'release'|'complete'
  id?: string
  parentId?: string | null
  ids?: string[]
  title?: string
  summary?: string
  expectedOutcome?: string  // 预期结果，单行 ≤240 字
  nextStep?: string         // 下一步，单行 ≤240 字
  temporary?: boolean       // 被紧急问题打断而插入的临时任务
  temporaryFor?: string | null // 被打断的主线任务 id（校验见不变量 11）
  outline?: string
  current?: string          // reviseGoal
  reason?: string           // reviseGoal / archive
  status?: 'pending'|'in_progress'|'blocked'|'done'
  executionApproval?: 'approved' | 'pending'
  approvalBasis?: string    // 授权的用户原话（校验真实用户消息）
  requiresUserAcceptance?: boolean
  acceptanceBasis?: string  // 豁免验收的用户原话
  progress?: string
  result?: string
  blockerReason?: string
  blockerUnblock?: string
  userBasis?: string        // defer/archive 改变交付时的用户原话
  deferredReason?: string
  resumeCondition?: string
  order?: number
  confirmedByUser?: boolean // complete：用户已验收
  confirmationBasis?: string // complete：验收的用户原话
  originalGoal?: string     // init
}
```

每个 op 只接受上表列出的字段；未知 op 或多余字段在写入前报错。行为：

- `init`：工作线不存在时创建，写 `originalGoal`/`outline`；已存在则报错（不要覆盖）。
- `create`：新建子任务，`parentId` 省略为顶层；返回新 id（`t1`…）。同级 order 默认追加。直接建在已批准父任务下的步骤继承授权。创建时写 `expectedOutcome` 说明「怎样算做完」。`done` / `blocked` 不能作为初始状态。
- `update`：局部更新 title/summary/expectedOutcome/nextStep/status/progress/result/blocker/executionApproval/requiresUserAcceptance；blocker 用两个字段，至少给 reason，两者都空表示清除；`status='done'` 走与 `complete` 相同的完成规则。记录进度时同时写 `nextStep`。
- 被紧急问题打断：为紧急问题建一条 `temporary: true` + `temporaryFor: <原任务>` 的任务，转移焦点，修完后 resume 原任务（并清空临时任务的焦点）。
- `move`：改 parentId / order；校验成环；已开始且未完成的交付任务不能移走。
- `defer` / `resume`：见不变量 4；defer 会清空领取记录与焦点。
- `archive` / `restore`：见不变量 5；archive 必须带 `reason`，递归归档同一批子树。
- `focus`：**整体替换**焦点集合（`ids: []` 表示清空）。
- `claim` / `release`：领取记录，不是权限。`claim` 校验活跃、未暂缓、`in_progress`、已授权，并拒绝第二个会话（compare-and-set）；`release` 直接清空记录，任何会话都可调用。二者都不写任何账本、不发号、不复活任何东西。
- `complete`：校验子任务全部结束；`requiresUserAcceptance` 的任务必须等用户验收（`confirmedByUser: true` + `confirmationBasis`），其余可自验完成（`completion: "self"`）；已完成但未验收的任务可以补记用户验收。
- 一次调用内先全量校验再写入；返回 `{ ok: true, worklineId, applied: [{op, id?}] }` 或抛出可读错误（含任务 id 与原因）。

工具描述（description）必须写清：何时读、何时写、短标题、不为琐碎修复建节点、完成前询问用户、目标修订需确认、只 Lead 维护（约定而非强制）、`claim`/`release` 只是记录。

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
      "summary": "…", "expectedOutcome": "…", "nextStep": "…",
      "temporary": false, "temporaryFor": null,
      "status": "in_progress", "settled": false,
      "executionApproval": "approved", "approvalBasis": "…", "approvalAt": 0,
      "requiresUserAcceptance": true, "acceptanceBasis": null,
      "deferred": false, "deferredReason": null, "resumeCondition": null,
      "blocker": null, "progress": "…", "result": null,
      "ownerSessionId": "session-…", "ownerName": null, "ownerLive": true,
      "completion": null, "completionBasis": null, "completedAt": null,
      "updatedAt": 0 }
  ],
  "archived": [
    { "id": "t9", "parentId": null, "title": "短信登录", "archiveReason": "…", "archivedAt": 0 }
  ],
  "archivedCount": 1
}
```

- 只返回未归档任务的完整数据；`archived` 最多 200 条（按 archivedAt 倒序）。
- `ownerSessionId` / `ownerName` / `ownerLive` 是领取记录：谁在任务上做了标记、那个会话现在是否还活着。它们只用于显示，不表示权限；`ownerLive: false` 表示记录里的会话已不在，面板显示「已离线」，任何会话都可以 `release` 后重新 `claim`。
- `settled` 是派生值：已完成且子树没有未完成项（见 §2 不变量 3）。
- 没有建树时：`available: true`，`goal: null`，`tasks: []`，`focus: []`，`archived: []`，`archivedCount: 0`。
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
- 内容只读：标题、状态文字、summary、预期结果（expectedOutcome）、下一步（nextStep）、进展、结果、阻塞原因、占用会话、完成方式；另有「子任务」区块列出直接子任务（标题 + 状态，点击沿用 `openTask` 打开对应任务）；临时任务在字段上方显示「临时任务，打断自 <任务名>」；上方「目标」区块展示 original/current 与修订记录；底部「已归档 N」可展开查看归档列表（原因、时间）。
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
- 单测：`npm test`（isolation / modules / docs-contract / host-contract / host / tasks / client），纯逻辑不引入 dsh 依赖（`host/model.js` 不 import dsh/zod）。`node test/modules.mjs` 逐个加载 `host/*.js`：删模块时残留的 `import` 会在这里变红；`node test/host-contract.mjs` 保证模型可见文本与 `client.js` 不广告已删除的 op 或字段；`node test/docs-contract.mjs` 保证本契约的 op 列表、`host/*.js` 引用与已删 surface 跟代码一致。

## 7. 验收（Lead 集成时执行）

1. 两半通过语法检查：`node --check index.js`、`node --check client.js`。
2. `npm test` 全绿（含 `node test/modules.mjs`：每个 `host/*.js` 都可加载；`node test/docs-contract.mjs`：契约与代码一致）。
3. 契约字段一致（客户端读取的字段 = Host 返回的字段）。
4. 现有四个分区行为不变；插件加载无报错。
5. live 验证：工具出现在 Agent 工具列表、`/summary-panel/tasks` 返回预期 JSON、面板显示任务树、入口呼吸灯出现、点击打开右栏详情。
