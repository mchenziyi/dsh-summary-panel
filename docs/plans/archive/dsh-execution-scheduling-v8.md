# DSH 执行调度方案 v8（冻结版）

> 状态：已全部实现（2026-11 核对）；本文件仅作历史记录，不再指引后续开发。
> 范围：在 DSH 插件 `@mchenziyi/dsh-summary-panel`（DSH Reins）内，为「任务 ↔ 执行实例」建立 Host 级强制绑定，实现标准模式单执行位与团队模式多 Worker 并行。
> 本文替代 v1–v7 的全部设计，v7 及更早版本仅作历史参考。

---

## 0. 结论摘要

| # | 关键结论 |
|---|---|
| 1 | 工具分三类：A（工作区修改/执行，需持有 active 执行）、B（任务管理与执行控制，按角色/归属授权）、C（只读） |
| 2 | 团队模式**废弃 `reassign`**（Host 拒绝）：claim 只能从 `pending` 发起，而 `reassign` 会把任务置为 `in_progress`，两者互斥 |
| 3 | 团队模式改为 **claim-first**：Lead 派发（dispatch）→ Worker 认领（claim）→ Host 绑定 |
| 4 | Claim 证据 = WAL 意图 + Board revision 严格 +1 + owner 匹配 + 座位独占；缺一即 `conflict` |
| 5 | 标准模式是**单文件单一事务**（claim 戳与执行索引同一次落盘），不存在跨存储窗口 |
| 6 | 并发靠三把**同步座位键**（workline / worker / task），TTL 只标 `suspect` 不释放 |
| 7 | `ended` 永不复活；`orphaned` 只授信给同一 sessionId |
| 8 | Force Release（语义终止）与 Reservation Release（并发座位）是两个独立操作 |

---

## 1. 三层架构与事实来源

| 信息 | 唯一事实源 | 持久位置 |
|---|---|---|
| 任务、层级、status、授权、验收、归档 | Reins Task Tree | `agent-task-tree/<workline>.json` |
| 团队派工（谁拥有） | **Team Board `ownerId`（由 claim 产生）** | Lead 会话日志 `team/task` |
| 团队执行状态 | Team Board `status` | 同上 |
| 标准执行状态 | 树内 `task.claim` 戳 | 树文件 |
| Reins ↔ 团队任务关联 | 树 `teamTaskId` | 树文件 |
| 派发意图（**不是**分配） | 树 `task.dispatch`（Host 专用） | 树文件 |
| 执行占用索引 | `executions[]` / `workers{}` | 树文件（派生，可重建） |

**总原则**：索引不是真相；索引缺失视为**无权限**（fail-closed）。

---

## 2. 数据模型

```jsonc
"t53": {
  …原有任务字段…,
  "assignee": "session-uuid" | "lead" | null,     // 仅标准模式
  "teamTaskId": "task-3" | null,                  // 仅团队模式
  "dispatch": { "member": "worker-a", "at": 0 } | null,   // 仅团队模式，claim 后清空
  "claim": { "executionId": "ex-7", "sessionId": "…", "attempt": 2, "at": 0 } | null
}

"executions": [{
  "executionId": "ex-7",          // 单调递增，终态不可逆
  "attempt": 2,                   // 任务内第几次执行
  "requestId": "call_abc",        // = exec.callId，Registry 分配，模型不可伪造
  "taskId": "t53", "teamTaskId": "task-3" | null,
  "mode": "standard" | "team",
  "executor": { "kind": "lead|teammate|subagent", "name": "worker-a",
                "memberId": "…", "sessionId": "…" },
  "state": "active" | "cold" | "orphaned" | "ended",
  "claimRevision": 42,            // 团队模式：claim 时 Board 的 revision（取自真实返回值）
  "startedAt": 0, "updatedAt": 0, "endedAt": null,
  "interruptedAt": null,
  "endReason": "completed|failed|released|reassigned|archived|deferred|force-terminated|board-released|lost|reconciled",
  "note": null, "rebuiltFrom": null
}]

"workers": {   // 只登记 teammate/subagent；Lead 不登记（豁免终身一任务）
  "<sessionId>": { "kind": "teammate"|"subagent", "name": "worker-a",
                   "state": "created"|"bound"|"ended",
                   "boundTaskId": "t53"|null, "executionId": "ex-7"|null,
                   "endedAt": null, "endReason": null }
}

"conflicts": [{   // workline 级，不是 execution 状态
  "id": "cf-1", "scope": "task"|"workline", "taskId": "t53"|null,
  "kind": "unproven-claim|ended-but-owned|claim-without-record|seat-ambiguous",
  "evidence": {…}, "createdAt": 0, "resolvedAt": null, "resolution": null
}]

"appliedOps": { "call_abc": { "at": 0, "state": "done", "executionId": "ex-7", "result": {…} } }
```

WAL（团队模式，追加写）：

```jsonc
{"requestId":"call_abc","state":"prepared|committed|aborted",
 "intent":"claim|release|complete|reopen|force-release",
 "taskId":"t53","teamTaskId":"task-3","sessionId":"…","member":"worker-a",
 "attempt":2,"revisionBefore":41,"at":0}
```

---

## 3. 工具分类

| 类 | 工具 | 授权 |
|---|---|---|
| **A** | `write` `edit` `str_replace_editor` `apply_patch` `bash` `terminal_*` `pwsh_*` `create_worktree` `working_directory` `run_code` `workflow` `ralph` `subagent*` | 必须持有该 workline 的 `active` 执行且 `sessionId` 相同；未 `init` 的 workline 不适用 |
| **B** | `task_tree_*` `team_task_*` `spawn_teammate` `send_message` `wait_agent` `list_agents` `interrupt_agent` `ask_user_question` `todo_write` `schedule_*` `present` `session_*` `goal` | 角色 + 归属 + 生命周期；**不需要执行权**（因此 claim 不存在循环依赖） |
| **C** | `read` `grep` `glob` `read_image` `web_*` `job_*` `skill` `cordis_inspect_*` | 始终允许 |

---

## 4. 不变量

| ID | 内容 |
|---|---|
| I0 | A 类要求 active 执行且 sessionId 相同；`cold/orphaned/ended` 不授权 |
| I0' | B 类不需要执行权 |
| I1 | 一个任务至多 1 条非终态执行 |
| I2 | 一个 sessionId 至多 1 条非终态执行 |
| I2b | teammate/subagent 终身至多 1 条绑定；`ended` 与强制终止都不解除；**Lead 豁免** |
| I3 | 标准模式：整个 workline 至多 1 条非终态执行 |
| I4 | 团队模式：Lead 不持有执行记录 |
| I5 | 团队模式树不写 `assignee` |
| I6 | `sessionId` 只能由 Host 从活 Agent 解析 |
| I7 | Lead 只能结束**自己**的 active 执行；结束**他人**的 active 执行必须走 §8.3 强制终止 |
| I8 | 树 status ∈ {done, deferred, archived} 时不得存在非终态执行 |
| I10 | `executionId` 单调递增、终态不可逆；ended 永不恢复为 active |
| I11 | `ownerId` 与 `assignee` 单独都不构成 Claim 证据；重建须满足 §6 |
| I12 | 证据矛盾/不足时生成 conflict，不建不删不复活，并阻止该 scope 新 claim |
| I13 | 终态顺序：团队先 Board 后账本；标准先树（含 claim 戳）后索引 |
| I14 | 并发座位：workline / worker / task 同一时刻只能一个 requestId |
| I15 | 预占只在「调用已结束」的证据下释放；TTL 只标 suspect |
| I16 | `orphaned` 只能转回 `active`（同一 sessionId）或转 `ended`（显式释放） |
| I17 | 对账修改三处镜像必须带 `executionId`+`sessionId` 守卫，绝不清理新一轮数据 |
| **I18** | 团队模式下 Host **拒绝 `team_task_update reassign`**（两角色均拒）；分配只能由 Worker `claim` 产生 |

---

## 5. 标准模式

### 5.1 流程

```
① create / focus [tA]        focus 只改注意力，不改 status
② claim {id:tA}              B 类操作 → 同一次文件写：status=in_progress + claim 戳 + executions
③ write/edit/bash            A 类，校验 ex.sessionId
④ complete {id:tA}           I7 允许（自己的执行）→ 同一次写：ended(completed) + claim 清空 + done
   或 release {id:tA}        → ended(released)，任务仍 in_progress
```

### 5.2 交接闭环

```
1. Lead release {id:tA}                          → ex-1 ended，claim 清空
2. Lead assign {id:tA, member:"<subagentId>"}    ← subagent 工具返回值即子会话 id
3. 子会话 claim {id:tA}                          → ex-2
4. 执行
5. 子会话 release {id:tA, outcome:"done"|"failed", note}
6. Lead assign {member:"lead"} + claim           → ex-3（重新接手）
   或 Lead complete                              → 验收
```

重新 claim 五前提：`status==='in_progress'`、`claim===null`、`assignee` 匹配、无其它 active、不受 I2b 限制。满足即新建 `executionId`（`attempt+1`）。

---

## 6. 团队模式（claim-first）

### 6.1 流程

```
① Lead  team_task_create                         → task-3（pending，无 owner）
② Lead  task_tree create t53
③ Lead  task_tree assign {id:t53, teamTaskId:"task-3"}
④ Lead  task_tree dispatch {id:t53, member:"worker-a"}     ← 路由，不是分配
⑤ Lead  spawn_teammate {name:"worker-a", prompt:"认领 team-task-3 并执行 t53"}
        → agent/created（serial，早于首轮）→ membership(agent) 取真实 sessionId
        → workers[sessionId].state = "created"（此时无任何 A 类权限）
⑥ Worker team_task_update {task-3, claim}
        guard：dispatch.member === caller.name ∧ workers[caller].state === "created"
        Board：pending → in_progress，ownerId = worker（CAS，revision 严格 +1）
⑦ Host post-execute（拿到真实返回值）：
        WAL committed → executions 写 ex-N(active, claimRevision=R+1)
        → 树 t53: in_progress + claim 戳 + dispatch 清空 + workers.bound
⑧ 从此刻起 Worker 才有 A 类权限
⑨ 收尾（见 6.3）
⑩ Lead 验收 → task_tree complete
```

### 6.2 为什么废弃 reassign

源码事实（`dsh-experimental-agent-team/lib/types/task-board.js`）：

- `claim` 要求 `status === 'pending'`（:117-119），否则 `TEAM_TASK_BLOCKED`
- `reassign` 直接把任务置为 `in_progress` + `ownerId`（:157-171）

两者互斥：「先 reassign 再 claim」必然失败。而若采用 reassign 路径，Worker 永远不 claim，也就没有「claim 成功」这一事实，无法满足「不得把 reassign 伪装成 claim」。

**结论**：团队模式唯一自洽的路径是 claim-first；`reassign` 由 Host 拒绝（I18）。

**代价（明确记录）**：Lead 不能直接把任务塞给某个 Worker，只能派发 + 认领。若要恢复「Lead 直接分配」，则必须回到 reassign 路径并放弃 claim 证据，二者不可兼得。

### 6.3 三条收尾路径（Board 先行）

| 路径 | 序列 |
|---|---|
| 正常完成 | `team_task_update {complete}` → Board completed（owner 保留）→ 账本 ended(completed) + claim 清空 + 树仍 in_progress |
| 失败上报 | `task_tree_write {op:"release", id, outcome:"failed", note}` → 校验 caller 是 ex-N 所有者 → Board `release`（先行）→ 账本 ended(failed) → workers.ended；Board 失败则 WAL aborted、账本保持 active、可重试 |
| 强制终止 | `interrupt_agent`（只记 interruptedAt）→ 确认 non-running → `task_tree_write {op:"release", id, force:true, reason}` → Board `release`（先行）→ 账本 ended(force-terminated) → workers.ended |

**重派**：`release`（失败）或 `reopen`（已完成）把任务打回 `pending`，新 Worker 再 `claim`。全程不用 reassign。

---

## 7. Claim 证据（问题 1）

### 7.1 三阶段

| 阶段 | 载体 | 证明什么 |
|---|---|---|
| P1 意图 | WAL `prepared`（同步，dispatch 前） | 该 session 在 revision=R 时打算 claim |
| P2 执行 | Board CAS 返回的 `TeamTaskView` | revision=R+1、status=in_progress、ownerName=调用者 |
| P3 提交 | `executions[]` + `workers` + WAL committed | 执行已登记，A 类权限生效 |

### 7.2 证据判定

| 现场 | 判定 |
|---|---|
| P3 已写 | 正常，无需重建 |
| P1+P2 成立、P3 丢失 | **可重建**：WAL.prepared ∧ `Board.revision === revisionBefore+1` ∧ `ownerId === WAL.sessionId` ∧ `status==='in_progress'` ∧ `workers[session].state !== 'ended'` ∧ 期间无其他写入（座位 `tk:` 独占） |
| 只有 `in_progress + ownerId` | **不可重建** → conflict `unproven-claim` |
| `revision > revisionBefore+1` | 中间有他人写入 → conflict |
| `ownerId ≠ WAL.sessionId` | conflict |
| `workers[session].state === 'ended'` | conflict（不得复活已终止的 Worker） |

revision 可信度的两个前提：每次成功 update 恰好 `revision = current.revision + 1`（:186-189），且 CAS 以 `expectedRevision` 为准（:97-99）；再加上「prepare 到调用结束期间座位 `tk:` 独占」，本请求即该窗口内唯一写入者。**该证明依赖 I18 与座位锁，二者缺一则失效。**

---

## 8. 恢复与终止

### 8.1 标准模式（单存储）

| 现场 | 恢复 |
|---|---|
| Prepare 后崩溃（树未写） | 无痕 → abort，释放座位 |
| 树已写 | 戳、索引、status 同一次落盘，一致，无半写 |
| WAL 存在但树无戳 | 同第一行 |
| 旧 attempt 残留 | 以 `claim.attempt` 为准；WAL attempt 不同即陈旧 → abort |
| 旧执行者复活 | I0 要求 active 且 sessionId 相同；戳已清除/替换 → 无权限 |

### 8.2 团队模式（双存储）

| 现场 | 恢复 |
|---|---|
| Board claim 成功、账本未写 | 按 §7.2 三件套重建（`rebuiltFrom:"wal"`） |
| 只有 reassign、没有 claim | 不可能出现（I18）；历史遗留 → conflict，不恢复 |
| Worker 已 ended、Board 仍 owner | 不复活；Board 仍 in_progress → conflict `ended-but-owned`，阻止新 claim 直到 Lead release |
| 轮次识别 | `claimRevision`（真实返回值）+ `attempt`（单调）+ revision 严格 +1 |
| 无法证明 | conflict，fail-closed |

### 8.3 Force Release 与 Reservation Release 的边界

| 概念 | 定义 | 判据 |
|---|---|---|
| Execution 终止 | 语义结束一次执行 | Board `release/complete` 成功（团队）或树写入成功（标准） |
| 工具调用结束 | 某 requestId 不再可能产生副作用 | `tools/result` 已到达 |
| Reservation 释放 | 释放内存并发座位 | 只认 E1/E2/E3 |

规则：
1. `interrupt_agent` 只证明「发出了中断请求」（fire-and-return，目标可能继续运行）→ 不能作结束证据。
2. Agent `running → idle` 可证明该 Agent 当前无在途工具调用（调用在 turn 内被 await）→ 可作 E2。
3. `tools/result` 覆盖每次进入 registry 的调用（含拒绝、UNKNOWN_TOOL、中止、超时）→ E1。
4. TTL 只标 `suspect`，不释放。
5. Force Release 不清除在途调用：它同样要占 `tk:` 座位，被在途请求占用时**直接拒绝**。
6. 只有 E1/E2/E3 至少一条成立才释放 reservation。
7. 无法确认 → 保留 suspect/conflict，宁可暂时不可用。

---

## 9. 并发预占

| 模式 | 座位键 |
|---|---|
| 标准 | `wl:<worklineId>` |
| 团队 | `wk:<sessionId>` + `tk:<taskId>` |

状态机：`inflight` —(E1/E2/E3)→ 释放；`inflight` —TTL→ `suspect`（拒绝该键新占位，不释放）—(E1/E2/E3)→ 释放。

所有改变执行归属的操作（claim / release / complete / reopen / force-release）都必须先占 `tk:`。

---

## 10. 权限矩阵

| 操作 | 团队 Lead | Worker（持位） | Worker（ended） | 标准 Lead | 标准 Subagent |
|---|---|---|---|---|---|
| A 类 | ❌ | ✅ | ❌ | ✅ 仅自己执行 | ✅ |
| task_tree 结构操作 | ✅ 仅无 active | ❌ | ❌ | ✅ | ❌ |
| task_tree claim | ❌ | ❌ | ❌ | ✅ | ✅ 仅自己 assignee |
| task_tree dispatch | ✅ | ❌ | ❌ | — | — |
| task_tree release | ✅ 仅无 active 清理 | ✅ 仅自己任务 | ❌ | ✅ 仅自己 | ✅ 仅自己 |
| task_tree release {force} | ✅ 仅 §6.3 | ❌ | ❌ | ✅ 同上 | ❌ |
| task_tree complete | ✅ 仅无 active | ❌ | ❌ | ✅ 仅自己 | ❌ |
| team_task claim | ❌ | ✅ dispatch 匹配 + state=created | ❌ | — | — |
| **team_task reassign** | **❌（I18）** | ❌ | ❌ | — | — |
| team_task release/complete | ✅ 仅无 active | ✅ 仅自己 | ❌ | — | — |
| team_task reopen | ✅ 仅无 active | ❌ | ❌ | — | — |
| team_task_create / spawn / interrupt | ✅ | ❌ | ❌ | — | — |

---

## 11. 测试要点

| # | 场景 | 预期 |
|---|---|---|
| 1 | Worker 未 claim 即 write | 拒绝 |
| 2 | Worker 未 claim 即 claim | 成功（B 类无循环依赖） |
| 3 | Lead 调 reassign | 拒绝（I18） |
| 4 | 仅 reassign 无 claim | 不建 active |
| 5 | 同 Worker 并发 claim 两任务 | 第二个 deny |
| 6 | 两 Worker 并发 claim 同一任务 | 只有一个成功 |
| 7 | 标准 Lead 与 Subagent 同时 claim | 第二个 deny |
| 8 | 标准 Lead 自己 complete/release | 成功（I7） |
| 9 | 标准 Subagent 持位时 Lead complete | 拒绝 |
| 10 | 三次交接 claim | 三个 executionId，attempt 递增 |
| 11 | Worker 失败 release | Board 先，账本后，note 落库 |
| 12 | Worker 对他人任务 release | 拒绝 |
| 13 | Worker A 失败 → B 接手 | B 新 executionId；A 保持 ended |
| 14 | 账本 ended + Board 同 owner 仍 in_progress | conflict，不复活 |
| 15 | TTL 到期但仍在跑 | 只标 suspect，不释放 |
| 16 | 崩溃注入（Board 成功/账本未写） | 三件套重建；否则 conflict |
| 17 | 团队 3 Worker 并行 | 3 条 active 互不干扰 |
| 18 | 读接口 schema | assertSchema 通过 |

真实 DSH 另跑：标准串行、交接闭环、团队并行、失败重派、强制终止、重启对账。

---

## 12. 实施顺序

`ledger.js` → `identity.js` → `reservation.js` → `guard.js` → `model.js` → `reconcile.js` → `tools.js` → `prompt.js` → 测试 → 文档。

---

## 13. 源码依据

| 结论 | 位置 |
|---|---|
| claim 只能在 pending | `task-board.js:110-120` |
| reassign 直接置 in_progress+owner | `task-board.js:157-172` |
| release → pending，owner 清空 | `task-board.js:121-126` |
| reopen → pending，owner 清空 | `task-board.js:151-156` |
| 每次 update revision+1 | `task-board.js:186-189` |
| CAS 以 expectedRevision 为准 | `task-board.js:96-99` |
| 无 action 字段持久化（只写 task 快照） | `task-board.js:191` |
| `tools/result` 覆盖每次调用 | `dsh-tools/lib/types/index.js:1043-1090` |
| guard 单调、dispatch 前 | `dsh-tools/lib/types/index.js:535-545, 896` |
| `exec.callId` 由 Registry 分配 | `dsh-tools/lib/types/index.js:778-800` |
| `agent/status` 由 setPhase 发出 | `dsh-agent-loop/lib/index.js:791-798` |
| interrupt 为 fire-and-return | `dsh-subagent/lib/index.js:3080-3097` |
| 成员 id 预生成且模型不可见 | `roster.js:211-221`、`tool-agent-team/lib/index.js:76-82` |

---

## 14. 已知限制

1. Lead 无法直接指派，只能派发 + 认领（claim-first 的代价）。
2. 无只读 diff 工具，团队 Lead 无法自查改动，需 Worker 汇报。
3. Worker 持位期间 `bash` 可写任意文件，`writeScopes` 只是建议。
4. ~~未建树的 workline 不受 A 类约束（普通问答不受影响）。~~ **已由 ADR-0001 取消**：空工作线同样拒绝 A 类工具（没有可 claim 的任务），拒绝理由给出 `init` → `create` → `claim` → 重试。普通问答与只读工具仍不受影响。
5. 多进程并发写同一 profile 不支持。
