# 摘要面板（summary-panel）

右上角点开的浮窗式摘要面板：**面板是容器，Git 只是第一个分区**。以后加功能 = 加一个分区，不用碰外壳。

## 安装

### 通过插件市场（推荐）

1. **插件** → **更多**（实验性插件）→ 打开 **自定义插件市场**；
2. 打开 **发现** → **添加索引源**，填入：

   ```
   https://raw.githubusercontent.com/mchenziyi/dsh-summary-panel/main/site/index.json
   ```

3. 在市场里找到 **摘要面板（Summary Panel）** 并安装。

索引文件在仓库的 `site/index.json`，按 DSH 插件市场索引格式手写；安装来源是仓库 Git 提交，不依赖 npm 发布。

### 直接从 Git 安装

也可以让 DSH 的插件管理器直接从仓库安装（Git URL + 提交 + 根目录），安装的是同一个组合包。

## 形态

- 入口：会话头部右上角工具区（`conversation.session.header.utilities`），在 open-in-app、定时任务之后、会话日志下载之前。
- 浮窗：`shell.overlay` 全帧浮层，**锚定在入口按钮下方**（打开时测量按钮位置，打开期间每 300ms 跟随一次，右栏展开/窗口缩放时面板跟着按钮移动）；宽度固定 420px，**高度随内容自适应**（折叠后自动收缩，超过视口才滚动）；支持 Escape 关闭、点击外部关闭、手动刷新、每 20 秒自动刷新。
- 语言：中 / 英，跟随 Harness 语言设置。
- 主题：只用 `--dsw-*` 主题 token（含 `--dsw-elevation-panel`、`--dsw-radius-lg`），跟随明暗主题。
- 面板底色与对话页一致（`--dsw-alias-bg-base`），不再用菜单/浮层的灰色底（`bg-overlay`）。

## 当前分区

| 分区 | 数据来源 | 内容 |
|---|---|---|
| Git | Host 跑 `git` 只读命令 | 仓库名 / 路径、当前分支、ahead/behind、工作区状态（暂存/修改/未跟踪/冲突）；「分支」「最近提交」两个子块默认收起，分支按文件夹再折叠一层，展开后显示 ahead/behind 徽标、短 hash、subject、作者、相对时间、refs |
| 输出内容 | 会话事件 + 实时 `git status` | `deliverables/presented` 交付文件；**未提交变更**文件列表（修改/新增/删除/重命名/冲突/未跟踪），点一行打开右栏 live diff |
| 子智能体 | Host `ctx.subagents.listChildren` | 子会话 label、模式（一次性/可继续）、创建时间；运行中的行显示旋转指示；点击跳转到该子会话 |
| 来源 | 会话 `tool/call` 事件 | 默认**当前轮**：网页搜索词、抓取的 URL、读写的文件、工具调用次数；「查看全部」切到整个会话。文件行点击打开右栏文件预览，抓取的 URL 点击打开右栏浏览器 tab |

Git 分区是只读的：不做 checkout / fetch / push。工作目录不是仓库、或会话还没有工作目录时显示空状态。

## Host 端点

前缀 `GET /summary-panel/`，全部经过 `connection.requestRejection` 的信任围栏，返回 `cache-control: no-store`：

- `/summary-panel/git?sessionId=...`
- `/summary-panel/outputs?sessionId=...`（交付文件 + 未提交变更列表）
- `/summary-panel/diff?sessionId=...&path=<repo 相对路径>`（工作区 vs HEAD 的 unified diff；未跟踪文件按整文件新增；只读）
- `/summary-panel/subagents?sessionId=...`
- `/summary-panel/sources?sessionId=...&scope=turn|session`

Git 通过 `ctx.subprocess` 运行，环境与 `dsh-workspace-changes` 一致：`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_CONFIG_COUNT=0`、`LC_ALL=C`，单次 6 秒超时、输出有上限。

## 子智能体会话的适配

- 当前会话是子智能体时（`SessionHeader.origin === 'subagent'` / 有 `parentSession`），面板顶部多一条上下文条：子智能体 label（取不到就显示 id）、「子智能体会话」和「返回父会话」按钮。
- 子智能体没有内容的分区自动隐藏（Git 不是仓库、没有交付/变更、没有下级子智能体、没有来源时），只留有信息的部分。
- 已结束、进程里不再 live 的子会话，Host 会退回 `sessionPersistence` 读持久化日志（最近 4000 条事件），不再返回 404。

## 信息层级

默认只给最重要、最简洁的信息；要看细节再逐层展开：

- **分区层**：Git 默认展开，输出内容 / 子智能体 / 来源默认收起，只在标题行显示数量徽标。
- **分区内子块**：Git 里的「分支 (N)」「最近提交」默认收起。
- **子块内分组**：分支按第一段前缀折成文件夹（`backup/`、`feature/`…），默认收起；当前分支固定在最上面。
- 所有折叠只影响展示，不改变数据刷新。

## 未提交变更 → 右栏 live diff

点「未提交变更」里的文件行会：

1. 收起摘要浮窗；
2. 自动展开右侧栏并打开本插件注册的 `summary-panel.diff` tab；
3. tab 里请求 `/summary-panel/diff`，显示 `git diff HEAD -- <path>` 的只读 diff（暂存 + 未暂存合并，hunk 头、新旧行号、+/− 底色用 `--dsw-alias-code-diff-added/deleted`）。
   - 「统一」：单栏，支持上下 + 左右滚动。
   - 「拆分」：左右两栏，各自可横向滚动，**垂直和水平滚动两边同步**，长行不折行。

同一个 tab 会被复用：再点另一个文件，tab 聚焦并切换到新文件（侧栏页签按 pane 去重）。二进制文件、超大 diff（>4000 行）、已无改动的文件都有对应空状态。

## 来源的点击行为

- **子智能体**：点击一行会把主视图切到该子会话（`uiWorkspace.openSession` 的子代理地址），和内置子智能体目录的跳转一致。
- **文件**：来源里的文件和「输出内容 → 交付文件」都可以点，收起浮窗后在右栏打开该文件的预览（`dsh-resource://file/session/<sessionId>/<path>`，复用右栏自带的文件预览 tab）。工作区之外的文件可能被预览拒绝，tab 会显示读取失败。
- **网页链接**：`web_fetch` 抓取的 URL 和 `web_search` 结果里的来源链接都会列出来，点击后收起浮窗，右栏打开浏览器 tab（`openTab('browser', { params: { url } })`）；没有浏览器 tab 的宿主会退回新窗口打开。
- **搜索词**：单独一组，保持纯文本（它不是可打开的目标）。

## 给其他插件加分区

客户端服务 `ctx.summaryPanel`（`ctx.get('summaryPanel')` 或声明 `inject: ['summaryPanel']`）：

```js
const dispose = ctx.summaryPanel.register({
  id: 'my-section',        // 必填、唯一
  order: 100,              // 可选，内置分区是 10/20/30/40
  title: '我的分区',        // 可选
  icon: 'panel',           // 可选，内置图标名：panel/git/branch/file/robot/globe/link/search
  render({ sessionId, nonce, t, locale }) {
    // 返回 React 元素；nonce 变化时重新取数
    return React.createElement('div', null, sessionId);
  },
});
// dispose() 注销
```

`render` 抛错只影响该分区，不会带崩面板。

## 文件

- `index.js` — Host 半：四个只读端点和 git 解析。
- `client.js` — Client 半：入口按钮、浮窗、分区注册表、四个内置分区。
- `cordis.patch.yml` — 插入 Host 行。
- `locale/*.json` — 插件管理页显示的标题与描述。
- `icon.svg` — 插件图标。

## 已知限制（v1 有意为之）

- Git 只读、单仓库：以会话工作目录所在仓库为准，不做多仓库、子模块、worktree 切换。
- 提交列表先不做分叉连线图（v2 再做）。
- 分支列表默认显示 10 个、提交默认 8 条，可展开。
- diff 是行级（git 的按行比较，含 3 行上下文、重命名检测），不是词级/字符级高亮；支持「统一 / 并排」切换；无语法高亮、无暂存/还原等写操作；超过 4000 行截断。
- 来源默认当前轮，整个会话范围最多扫描末尾 20000 条事件；更早的记录不显示。
- 刷新是打开时 + 每 20 秒 + 手动；没有监听 `.git` 文件变化。
