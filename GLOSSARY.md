# GLOSSARY

DSH Reins（缰绳）的领域词汇。写 issue、写测试名、写重构提案时用这里的词；不要造同义词。

---

## 核心实体

**工作线（workline）**
一个根会话及其全部子会话构成的整体。任务树按工作线隔离，存储键是根会话 id。
_代码_：`host/session.js` 的 `rootSessionId`（沿 `SessionHeader.parentSession` 上溯，≤50 层）。
_别说_：project、workspace、会话组。

**任务（task）**
任务树上的一个节点，有 `id`（`t1`、`t2`…）、父子关系、状态、授权与验收属性。
_代码_：`host/model.js` 的 `tasks[]`。

**子任务 / 父任务**
树结构中的层级关系，**不是**依赖关系。父子决定"父任务何时算完成"（见「结算」），不决定执行顺序。

**焦点（focus）**
当前注意力的任务集合，写在 `workline.focus`。**焦点不是执行**：它不影响 `status`，也不代表谁在做。
_别说_：当前任务、active task。当前正在做 = `status: in_progress` + 有执行者。

---

## 生命周期

**执行授权（executionApproval）**
`approved` 或 `pending`。`pending` 代表"还只是个想法"，不能进入执行、不能被认领。
独立的三个概念之一：授权（能不能做）/ 完成（做完没有）/ 验收（用户认不认）。

**认领（claim）**
把任务绑定到调用它的那个会话（`task.owner = { sessionId, since }`）。
占用关系，不是状态转移的替代品；任务必须先是 `in_progress`。

**完成（complete）**
把任务置为 `done`，并按规则决定是"自验完成"还是"用户验收完成"。

**验收（acceptance）**
交付类任务必须由用户明确接受才能完成。验收依据（`completionBasis`）必须引用用户真实说过的话，且**一句话只能关闭一个任务**。

**结算（settled）**
派生状态：`done` **且**其下没有任何未完成子任务。父任务带未完成子项时显示为"未结算"，但 `status` 仍是 `done`、历史验收记录不重写。
_代码_：`host/model.js` 的 `isSettled` / `readSnapshot` 输出 `settled`。

**暂缓（defer）**
用户说"先不做"但可能会回来。保持 status 与进展，移出焦点；**仍然阻塞父任务**。

**归档（archive）**
确定不做，连同子树移出活动树，进归档区。**不再阻塞父任务**。需要用户依据。
_代码_：`archiveBatch` 记录批次，`restore` 按批次还原，避免连带复活早期单独归档的子任务。

---

## 执行与协作

**执行者 / 执行实例**
当前真正在做这个任务的会话。标准模式下是 Lead 自己或其 Subagent；团队模式下是一个 Worker。

**子智能体（subagent）**
由 `subagent` 工具创建的一次性/可续子会话，`origin: 'subagent'`。

**团队成员（teammate）**
Agent Team 里的命名成员，身份由 roster 的 `member.id`（= 子会话 id）确定。

**派发（dispatch）**
Lead 让某个 Worker 去认领某个任务的路由提示。**派发不是分配**：分配事实是 Team Board 的 `ownerId`，由 claim 产生。

**执行（execution）**
一次"某会话持有某任务"的登记，写在 `workline.executions[]`，终态不可复活。
**只有认领证据才能建立执行**：派发、分配、Board 上的 `ownerId` 单独都不算证据。

**执行证据（claim evidence）**
证明一次认领真的发生过的三件套：认领意图日志、Board revision 恰好 +1 且 owner 匹配、Worker 未终结。
缺一即「冲突」，Host 绝不猜执行者。

**认领意图日志（claim journal）**
认领 Board 调用**之前** `fsync` 落盘的意图记录（`<workline>.claims.jsonl`）：roster 会话 id、成员名、期望 revision、Registry callId。
是索引不是真相：丢了只会减少权限。崩溃后重启靠它把"Board 已提交、账本未写"补成一条执行。

**执行账本 / Worker 台账 / 执行戳**
三处镜像：`workline.executions[]`、`workline.workers{}`、`task.owner`。同一次原子写落盘；
对账改它们时都带 `executionId` 守卫，旧一轮的决定不会清掉新一轮。

**冲突（conflict）**
证据矛盾时挂在工作线上的记录（`workline.conflicts[]`），不是执行状态。
它阻止该任务的新认领、不建不删不复活执行，等人工处理。种类：`unproven-claim`、`claim-without-record`、`ended-but-owned`、`seat-ambiguous`。

**对账（reconcile）**
进程内每条工作线在第一次工具调用前（guard 判定之前）把三处镜像收敛为一致状态：可证明则重建一条执行，Board 已完成/释放则结束执行，无法证明则只记冲突。幂等，第二次重启不再产生新执行。
_代码_：`host/reconcile.js` 的 `convergeWorkline`。

---

## 交付与校验

**验收依据（completionBasis / approvalBasis / acceptanceBasis / userBasis）**
分别是：完成时的用户原话、授权时的用户原话、免除验收时的用户原话、暂缓/归档时的用户原话。都由 `host/evidence.js` 与真实用户消息逐条比对，模型伪造不了。

**交付完成（delivery complete）**
父任务能否关闭的判定：只有 `done` 与归档不阻塞；`pending`、`in_progress`、`blocked`、`deferred` 在任何深度都阻塞。
_代码_：`assertDeliveryComplete`。

**记住与重放（旧数据兼容）**
历史记录缺少 `executionApproval` / `requiresUserAcceptance` 时按位置补默认值（顶层 `pending` + 需验收），不是"未定义即放行"。

---

## 界面

**面板（panel）**：`shell.overlay` 槽位里的悬浮摘要窗，跟随主视图会话。
**入口按钮（entry button）**：会话头部右侧的按钮，空闲时有"呼吸灯"动画。
**右栏 tab**：`sidebarRightTabs` 里的 `summary-panel.task`，展示单个任务详情。
**浮层（popover）**：任务行旁弹出的轻量详情，不抢焦点。

---

## 两端

**Host 半**：`index.js` + `host/*.js`，跑在 DSH 主进程，负责存储、工具、提示词、HTTP 路由。
**Client 半**：`client.js`，跑在浏览器，负责渲染与交互。
**契约**：`CONTRACT.md`，Host/Client 共享的唯一接口约定；与需求文档冲突时以契约为准。
