/**
 * Client half of the summary panel bundle.
 *
 * Registers two seats:
 *  - `conversation.session.header.utilities`: the top-right entry button,
 *    beside the shipped utilities (Codex-style entry).
 *  - `shell.overlay`: the floating panel itself, anchored to the right edge.
 *
 * Built-in sections are the summary panel's own (Tasks, Git, outputs,
 * subagents, sources). Other plugins may register further sections through
 * the client service `ctx.summaryPanel`.
 */

window.__ModuleLoader__.load({
  id: '@mchenziyi/dsh-summary-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'summary-panel';

    // ------------------------------------------------------------------
    // copy
    // ------------------------------------------------------------------

    const ZH = {
      'entry.label': '摘要',
      'entry.focusTitle': '{label} · {title}',
      'panel.title': '缰绳',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
      'section.tasks': '当前任务',
      'tasks.empty': 'Agent 开始工作后会自动建立任务树',
      'tasks.unavailable': '任务树依赖的存储不可用',
      'tasks.expand': '展开',
      'tasks.collapse': '收起',
      'tasks.deferred': '暂缓',
      'tasks.tabTitle': '任务',
      'tasks.status.pending': '待开始',
      'tasks.status.inProgress': '进行中',
      'tasks.status.blocked': '阻塞',
      'tasks.status.done': '已完成',
      'tasks.tip.blocker': '阻塞原因：{reason}',
      'tasks.childrenProgress': '子任务 {done}/{total} 已完成',
      'tasks.detail.archiveHistory': '归档历史',
      'tasks.detail.title': '任务',
      'tasks.detail.noTarget': '没有指定任务',
      'tasks.detail.missing': '任务不存在或已归档',
      'tasks.detail.info': '任务信息',
      'tasks.detail.goal': '目标',
      'tasks.detail.original': '原始目标',
      'tasks.detail.current': '当前目标',
      'tasks.detail.outline': '目标大纲',
      'tasks.detail.changes': '修订记录 ({n})',
      'tasks.detail.status': '状态',
      'tasks.detail.subtreePending': '仍有未完成子任务',
      'tasks.detail.summary': '简介',
      'tasks.detail.progress': '进展',
      'tasks.detail.result': '结果',
      'tasks.detail.blocker': '阻塞原因',
      'tasks.detail.unblock': '解除条件',
      'tasks.detail.owner': '占用会话',
      'tasks.detail.ownerLive': '存活',
      'tasks.detail.ownerGone': '已离线',
      'tasks.detail.ownerLost': '执行者已失联',
      'tasks.tip.executorLost': '执行者已失联：该执行不授予工作区权限，需 Lead 先中断并确认其已停止，再强制释放',
      'tasks.detail.completion': '完成方式',
      'tasks.detail.completionUser': '用户确认',
      'tasks.detail.completionSelf': 'Agent 自行确认',
      'tasks.approvalPending': '待授权',
      'tasks.tip.approval': '想法已记录，等你确认后再执行',
      'tasks.detail.approval': '执行授权',
      'tasks.detail.approvalApproved': '已授权',
      'tasks.detail.approvalPending': '待授权',
      'tasks.detail.approvalBasis': '授权依据',
      'tasks.detail.acceptance': '用户验收',
      'tasks.detail.acceptanceRequired': '等待用户验收',
      'tasks.detail.acceptanceOptional': '不需要',
      'tasks.detail.acceptanceBasis': '免验收依据',
      'tasks.detail.completionBasis': '验收依据',
      'tasks.detail.deferredReason': '暂缓原因',
      'tasks.detail.resumeCondition': '恢复条件',
      'tasks.detail.updated': '更新于 {time}',
      'tasks.detail.archivedTitle': '已归档任务',
      'tasks.detail.archivedEmpty': '暂无归档任务',
      'tasks.detail.openTab': '在右栏打开',
      'tasks.detail.archived': '已归档 {n}',
      'tasks.detail.archiveReason': '归档原因',
      'tasks.detail.archivedAt': '归档于 {time}',
      'section.git': 'Git',
      'section.outputs': '输出内容',
      'section.subagents': '子智能体',
      'section.sources': '来源',
      'git.detached': '已分离',
      'git.clean': '工作区干净',
      'git.staged': '暂存 {n}',
      'git.modified': '修改 {n}',
      'git.untracked': '未跟踪 {n}',
      'git.conflicted': '冲突 {n}',
      'git.branches': '分支 ({n})',
      'git.folderHint': '{n} 个分支，点击展开',
      'git.commits': '最近提交',
      'git.showLess': '收起',
      'git.showAllBranches': '显示全部 {n} 个分支',
      'git.showAllCommits': '显示全部 {n} 条',
      'git.gone': '已失效',
      'git.noRepo': '当前工作目录不是 Git 仓库',
      'git.noCwd': '这个会话还没有工作目录',
      'git.noCommits': '还没有提交',
      'outputs.deliveries': '交付文件',
      'outputs.workingTree': '未提交变更',
      'outputs.empty': '还没有输出内容',
      'outputs.clean': '工作区没有未提交改动',
      'outputs.noRepo': '不是 Git 仓库，无法读取工作区状态',
      'outputs.count': '{n} 个文件',
      'status.modified': '修改',
      'status.added': '新增',
      'status.deleted': '删除',
      'status.renamed': '重命名',
      'status.conflicted': '冲突',
      'status.untracked': '未跟踪',
      'status.staged': '已暂存',
      'diff.refresh': '刷新',
      'diff.empty': '当前没有未提交改动',
      'diff.binary': '二进制文件，无法显示 diff',
      'diff.truncated': 'diff 过长，仅显示前 {n} 行',
      'diff.unavailable': '无法读取 diff',
      'diff.badPath': '无效的文件路径',
      'diff.noTarget': '没有指定文件',
      'diff.split': '拆分',
      'diff.unified': '统一',
      'diff.layoutHint': '切换统一 / 并排视图',
      'subagents.empty': '还没有子智能体',
      'subagents.running': '运行中',
      'context.subagent': '子智能体会话',
      'context.unknown': '子智能体',
      'context.back': '返回父会话',
      'subagents.oneShot': '一次性',
      'subagents.continuable': '可继续',
      'subagents.unknown': '未知',
      'sources.web': '网页',
      'sources.files': '文件',
      'sources.tools': '工具',
      'sources.empty': '还没有来源',
      'sources.search': '搜索',
      'sources.fetch': '抓取',
      'sources.queries': '搜索词',
      'sources.showAll': '查看全部',
      'sources.showTurn': '只看本轮',
      'sources.emptyTurn': '本轮还没有来源',
      'sources.turnLabel': '第 {n} 轮',
      'sources.wholeSession': '整个会话',
      'state.loading': '加载中',
      'state.retry': '重试',
      'state.error': '加载失败：{message}',
      'state.empty': '暂无数据',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',
    };

    const EN = {
      'entry.label': 'Summary',
      'entry.focusTitle': '{label} · {title}',
      'panel.title': 'DSH Reins',
      'panel.refresh': 'Refresh',
      'panel.close': 'Close',
      'section.tasks': 'Tasks',
      'tasks.empty': 'The task tree appears once the agent starts working',
      'tasks.unavailable': 'Task tree storage unavailable',
      'tasks.expand': 'Expand',
      'tasks.collapse': 'Collapse',
      'tasks.deferred': 'Deferred',
      'tasks.tabTitle': 'Task',
      'tasks.status.pending': 'Pending',
      'tasks.status.inProgress': 'In progress',
      'tasks.status.blocked': 'Blocked',
      'tasks.status.done': 'Done',
      'tasks.tip.blocker': 'Blocked: {reason}',
      'tasks.detail.title': 'Task',
      'tasks.detail.noTarget': 'No task selected',
      'tasks.detail.missing': 'Task not found or archived',
      'tasks.detail.info': 'Task info',
      'tasks.detail.goal': 'Goal',
      'tasks.detail.original': 'Original goal',
      'tasks.detail.current': 'Current goal',
      'tasks.detail.outline': 'Outline',
      'tasks.detail.changes': 'Revisions ({n})',
      'tasks.detail.status': 'Status',
      'tasks.detail.subtreePending': 'Unfinished subtasks',
      'tasks.detail.summary': 'Summary',
      'tasks.detail.progress': 'Progress',
      'tasks.detail.result': 'Result',
      'tasks.detail.blocker': 'Blocker',
      'tasks.detail.unblock': 'Unblock when',
      'tasks.detail.owner': 'Owner session',
      'tasks.detail.ownerLive': 'live',
      'tasks.detail.ownerGone': 'offline',
      'tasks.detail.ownerLost': 'executor lost',
      'tasks.tip.executorLost': 'Executor lost: this execution grants no workspace permission; the Lead must interrupt the worker, confirm it stopped, then force-release it',
      'tasks.detail.completion': 'Completion',
      'tasks.detail.completionUser': 'User confirmed',
      'tasks.detail.completionSelf': 'Self-confirmed',
      'tasks.approvalPending': 'Needs approval',
      'tasks.tip.approval': 'Idea recorded; execution waits for your go-ahead',
      'tasks.detail.approval': 'Execution approval',
      'tasks.detail.approvalApproved': 'Approved',
      'tasks.detail.approvalPending': 'Needs approval',
      'tasks.detail.approvalBasis': 'Approved by',
      'tasks.detail.acceptance': 'User acceptance',
      'tasks.detail.acceptanceRequired': 'Waiting for the user',
      'tasks.detail.acceptanceOptional': 'Not needed',
      'tasks.detail.acceptanceBasis': 'Waived by',
      'tasks.detail.completionBasis': 'Accepted by',
      'tasks.detail.deferredReason': 'Deferred reason',
      'tasks.detail.resumeCondition': 'Resume when',
      'tasks.detail.updated': 'Updated {time}',
      'tasks.detail.archivedTitle': 'Archived task',
      'tasks.detail.archivedEmpty': 'No archived tasks',
      'tasks.detail.openTab': 'Open in sidebar',
      'tasks.detail.archived': 'Archived {n}',
      'tasks.detail.archiveReason': 'Archive reason',
      'tasks.detail.archivedAt': 'Archived {time}',
      'section.git': 'Git',
      'section.outputs': 'Outputs',
      'section.subagents': 'Subagents',
      'section.sources': 'Sources',
      'git.detached': 'Detached',
      'git.clean': 'Working tree clean',
      'git.staged': 'Staged {n}',
      'git.modified': 'Modified {n}',
      'git.untracked': 'Untracked {n}',
      'git.conflicted': 'Conflicted {n}',
      'git.branches': 'Branches ({n})',
      'git.folderHint': '{n} branches, click to expand',
      'git.commits': 'Recent commits',
      'git.showLess': 'Show less',
      'git.showAllBranches': 'Show all {n} branches',
      'git.showAllCommits': 'Show all {n} commits',
      'git.gone': 'gone',
      'git.noRepo': 'The working directory is not a Git repository',
      'git.noCwd': 'This session has no working directory yet',
      'git.noCommits': 'No commits yet',
      'outputs.deliveries': 'Delivered files',
      'outputs.workingTree': 'Uncommitted changes',
      'outputs.empty': 'No outputs yet',
      'outputs.clean': 'No uncommitted changes',
      'outputs.noRepo': 'Not a Git repository',
      'outputs.count': '{n} files',
      'status.modified': 'Modified',
      'status.added': 'Added',
      'status.deleted': 'Deleted',
      'status.renamed': 'Renamed',
      'status.conflicted': 'Conflicted',
      'status.untracked': 'Untracked',
      'status.staged': 'staged',
      'diff.refresh': 'Refresh',
      'diff.empty': 'No uncommitted changes',
      'diff.binary': 'Binary file; no diff available',
      'diff.truncated': 'Diff too long; showing the first {n} lines',
      'diff.unavailable': 'Unable to read the diff',
      'diff.badPath': 'Invalid file path',
      'diff.noTarget': 'No file selected',
      'diff.split': 'Split',
      'diff.unified': 'Unified',
      'diff.layoutHint': 'Toggle unified / split view',
      'subagents.empty': 'No subagents yet',
      'subagents.running': 'Running',
      'context.subagent': 'Subagent session',
      'context.unknown': 'Subagent',
      'context.back': 'Back to parent',
      'subagents.oneShot': 'One-shot',
      'subagents.continuable': 'Continuable',
      'subagents.unknown': 'Unknown',
      'sources.web': 'Web',
      'sources.files': 'Files',
      'sources.tools': 'Tools',
      'sources.empty': 'No sources yet',
      'sources.search': 'Search',
      'sources.fetch': 'Fetch',
      'sources.queries': 'Queries',
      'sources.showAll': 'View all',
      'sources.showTurn': 'This turn only',
      'sources.emptyTurn': 'No sources this turn',
      'sources.turnLabel': 'Turn {n}',
      'sources.wholeSession': 'Whole session',
      'state.loading': 'Loading',
      'state.retry': 'Retry',
      'state.error': 'Failed to load: {message}',
      'state.empty': 'Nothing to show',
      'time.justNow': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
      'time.days': '{n}d ago',
    };

    // ------------------------------------------------------------------
    // styles
    // ------------------------------------------------------------------

    const CSS = `
.sp-entry{position:relative;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;padding:0}
.sp-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-entry.sp-entry-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.sp-root{position:fixed;display:flex;pointer-events:auto;z-index:40}
.sp-panel{display:flex;flex-direction:column;flex:1;min-height:0;max-height:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel);overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px}
.sp-head{display:flex;align-items:center;gap:5px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sp-head-glyph{color:var(--dsw-alias-brand-primary);display:inline-flex}
.sp-head-title{flex:1;font-size:12.5px;font-weight:600;letter-spacing:.01em}
.sp-icon-btn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;cursor:pointer;padding:0}
.sp-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-body{overflow-y:auto;overscroll-behavior:contain;padding:4px 4px 10px;display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-height:0}
.sp-card{border-radius:10px;padding:2px 0}
.sp-card+.sp-card{border-top:1px solid var(--dsw-alias-border-l1)}
.sp-card-head{width:100%;display:flex;align-items:center;gap:6px;padding:6px 4px;background:transparent;border:0;color:inherit;cursor:pointer;border-radius:8px;text-align:left;font:inherit}
.sp-card-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-card-head>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-card-title{flex:1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sp-card-badge{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);padding:1px 7px;border-radius:999px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-card-body{padding:0 4px 6px;display:flex;flex-direction:column;gap:4px}
.sp-stack{display:flex;flex-direction:column;gap:7px}
.sp-repo{display:flex;flex-direction:column;gap:2px;padding-top:2px}
.sp-repo-name{font-weight:600;font-size:12.5px}
.sp-repo-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sp-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sp-row>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-branch-name{font-weight:600}
.sp-muted{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-ahead{color:var(--dsw-alias-state-success-primary);font-size:11.5px;font-weight:600}
.sp-behind{color:var(--dsw-alias-state-warn-primary);font-size:11.5px;font-weight:600}
.sp-chips{gap:5px}
.sp-chip{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sp-chip-mod{color:var(--dsw-alias-state-warn-primary)}
.sp-chip-new{color:var(--dsw-alias-state-success-primary)}
.sp-chip-warn{color:var(--dsw-alias-state-error-primary)}
.sp-chip-ok{color:var(--dsw-alias-state-success-primary)}
.sp-block{display:flex;flex-direction:column;gap:2px}
.sp-block-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.sp-subblock-head{border:0;background:transparent;font:inherit;font-size:11.5px;cursor:pointer;border-radius:6px;padding:3px 4px}
.sp-subblock-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-subblock-head>svg{flex:none}
.sp-list{display:flex;flex-direction:column;gap:1px}
.sp-item{display:flex;align-items:center;gap:6px;padding:4px 4px;border-radius:6px;font-size:12px;min-height:22px}
.sp-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-item>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-item-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-item-sub{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-branch{padding-left:calc(var(--depth) * 10px + 4px)}
.sp-folder-row{display:flex;align-items:center;gap:6px;width:100%;padding:3px 4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;border-radius:6px;cursor:pointer;text-align:left}
.sp-folder-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-folder-row>svg{flex:none}
.sp-folder-name{flex:1;font-weight:600;color:var(--dsw-alias-label-secondary)}
.sp-current{color:var(--dsw-alias-brand-primary);font-weight:600}
.sp-commit{display:flex;flex-direction:column;gap:1px;padding:5px 4px;border-radius:6px}
.sp-commit:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-commit-line{display:flex;align-items:baseline;gap:6px;min-width:0}
.sp-commit-hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.sp-commit-subject{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sp-commit-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding-left:0;flex-wrap:wrap}
.sp-ref{font-size:10.5px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sp-counts{display:flex;gap:6px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:none}
.sp-add{color:var(--dsw-alias-state-success-primary)}
.sp-del{color:var(--dsw-alias-state-error-primary)}
.sp-empty{color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:5px 2px}
.sp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sp-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;padding:2px 5px;border-radius:5px;font:inherit}
.sp-link:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-skeleton{height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);animation:sp-pulse 1.4s ease-in-out infinite}
.sp-skeleton.short{width:62%}
@keyframes sp-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.sp-context{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-skeleton);margin:2px 0 6px;flex:none}
.sp-context>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-context-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.sp-context-label{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-context-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sp-spin{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:sp-rotate .8s linear infinite;flex:none}
@keyframes sp-rotate{to{transform:rotate(360deg)}}
.sp-file-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;border-radius:6px;cursor:pointer;text-align:left;min-height:22px}
.sp-file-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-file-row>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.sp-file-tag{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.sp-status{flex:none;font-size:10.5px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-secondary)}
.sp-status-modified{color:var(--dsw-alias-state-warn-primary)}
.sp-status-added{color:var(--dsw-alias-state-success-primary)}
.sp-status-deleted{color:var(--dsw-alias-state-error-primary)}
.sp-status-renamed{color:var(--dsw-alias-state-business-primary)}
.sp-status-conflicted{color:var(--dsw-alias-state-error-primary)}
.sp-status-untracked{color:var(--dsw-alias-state-success-primary)}
.sp-diff-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px}
.sp-diff-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sp-diff-toolbar>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-diff-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.sp-diff-body{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55}
.sp-diff-table{min-width:max-content;padding-bottom:24px}
.sp-diff-row{display:flex;white-space:pre;height:20px;line-height:20px}
.sp-diff-num{width:44px;flex:none;text-align:right;padding-right:8px;color:var(--dsw-alias-label-caption);user-select:none}
.sp-diff-sign{width:16px;flex:none;text-align:center;color:var(--dsw-alias-label-secondary);user-select:none}
.sp-diff-text{flex:1;padding-right:18px}
.sp-diff-add{background:var(--dsw-alias-code-diff-added)}
.sp-diff-del{background:var(--dsw-alias-code-diff-deleted)}
.sp-diff-add .sp-diff-sign{color:var(--dsw-alias-state-success-primary)}
.sp-diff-del .sp-diff-sign{color:var(--dsw-alias-state-error-primary)}
.sp-diff-hunk{height:22px;line-height:22px;padding:0 12px;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:pre}
.sp-diff-meta{padding:0 12px;color:var(--dsw-alias-label-caption);font-size:11px;white-space:pre}
.sp-diff-notice{padding:6px 12px;color:var(--dsw-alias-state-warn-primary);font-size:11.5px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sp-diff-empty{padding:20px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sp-diff-split{min-width:0;width:100%}
.sp-diff-split-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.sp-diff-body-split{display:flex;overflow:hidden;padding:0;min-height:0;flex:1 1 auto}
.sp-split-pane{flex:1 1 50%;min-width:0;overflow:auto;overscroll-behavior:contain}
.sp-split-pane+.sp-split-pane{border-left:1px solid var(--dsw-alias-border-l1)}
.sp-split-content{min-width:max-content;padding-bottom:24px}
.sp-diff-span{white-space:pre}
.sp-diff-pair{display:flex;width:100%;min-width:0}
.sp-diff-side{display:flex;flex:1 1 50%;min-width:0;overflow:hidden;white-space:pre}
.sp-diff-side+.sp-diff-side{border-left:1px solid var(--dsw-alias-border-l1)}
.sp-diff-side .sp-diff-num{width:32px;padding-right:6px}
.sp-diff-side .sp-diff-text{flex:1;min-width:0;overflow:hidden;padding-right:8px;text-overflow:clip}
.sp-entry-dot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-static-blue-500);animation:sp-breathe 1.6s ease-in-out infinite;pointer-events:none}
.sp-entry-dot-warn{background:var(--dsw-alias-state-warn-primary)}
@keyframes sp-breathe{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion: reduce){.sp-entry-dot{animation:none;opacity:1}}
.sp-task-tree{display:flex;flex-direction:column;gap:0}
.sp-task-row{display:flex;align-items:center;border-radius:5px;min-height:20px;padding-right:2px}
.sp-task-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-task-row-focus{background:color-mix(in srgb,var(--dsw-static-blue-500) 10%,transparent)}
.sp-task-row-focus:hover{background:color-mix(in srgb,var(--dsw-static-blue-500) 15%,transparent)}
.sp-task-row-deferred{opacity:.5}
.sp-task-guide{width:11px;flex:none;align-self:stretch;border-left:1px solid var(--dsw-alias-border-l1);opacity:.55}
.sp-task-arrow{width:15px;height:19px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;border-radius:4px;opacity:.8}
.sp-task-arrow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);opacity:1}
.sp-task-arrow-space{width:15px;flex:none}
.sp-task-main{flex:1;min-width:0;display:flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:18px;padding:1px 2px;cursor:pointer;text-align:left;border-radius:5px}
.sp-task-icon{flex:none;display:block}
.sp-task-icon-pending{color:var(--dsw-alias-state-idle-primary)}
.sp-task-icon-in_progress{color:var(--dsw-static-blue-500)}
.sp-task-icon-blocked{color:var(--dsw-alias-state-warn-primary)}
.sp-task-icon-done{color:var(--dsw-alias-state-success-primary);opacity:.8}
.sp-task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.sp-task-row-parent>.sp-task-main>.sp-task-title{font-weight:600}
.sp-task-row-done>.sp-task-main>.sp-task-title{color:var(--dsw-alias-label-secondary);opacity:.86}
.sp-task-row-done>.sp-task-arrow{opacity:.55}
.sp-task-progress{flex:none;font-size:9.5px;line-height:1;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;opacity:.85;padding-left:2px}
.sp-task-progress-warn{color:var(--dsw-alias-state-warn-primary);opacity:1}
.sp-task-lost{flex:none;font-size:9px;line-height:1;letter-spacing:.02em;color:var(--dsw-alias-state-warn-primary);opacity:.95;padding:1px 3px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);border-radius:3px;white-space:nowrap}
.sp-task-approval{flex:none;font-size:9px;line-height:1;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);opacity:.72;padding:1px 3px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 26%,transparent);border-radius:3px;white-space:nowrap}
.sp-task-row-focus>.sp-task-main>.sp-task-title{font-weight:700}
.sp-task-tip{position:fixed;z-index:80;pointer-events:none;max-width:min(220px,calc(100vw - 16px));padding:4px 7px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 74%,transparent);backdrop-filter:blur(10px) saturate(1.15);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);box-shadow:0 6px 18px rgba(0,0,0,.10);display:flex;flex-direction:column;gap:1px;color:var(--dsw-alias-label-primary)}
.sp-tip-title{font-size:11px;font-weight:500;line-height:1.3;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sp-tip-text{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sp-tip-blocker{color:var(--dsw-alias-state-warn-primary)}
.sp-task-status{flex:none;font-size:10.5px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sp-task-status-pending{color:var(--dsw-alias-label-secondary)}
.sp-task-status-in_progress{color:var(--dsw-alias-brand-primary)}
.sp-task-status-blocked{color:var(--dsw-alias-state-warn-primary)}
.sp-task-status-done{color:var(--dsw-alias-state-success-primary)}
.sp-task-status-deferred{color:var(--dsw-alias-label-secondary)}
.sp-detail-pop{position:fixed;z-index:85;display:flex;flex-direction:column;gap:5px;padding:8px 9px;border-radius:8px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(10px));border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent);box-shadow:0 4px 16px rgba(0,0,0,.08);overflow:auto;font-size:11px;color:var(--dsw-alias-label-primary)}
.sp-detail-pop-head{display:flex;align-items:baseline;gap:6px}
.sp-detail-pop-title{flex:1;min-width:0;font-size:12px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.sp-detail-pop .sp-task-status{font-size:9.5px;padding:0;background:transparent;line-height:1.2}
.sp-detail-pop-fields{display:flex;flex-direction:column;gap:4px;min-height:0}
.sp-detail-pop .sp-detail-label{font-size:10px}
.sp-detail-pop .sp-detail-value{font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.sp-detail-pop-foot{display:flex;justify-content:flex-end;padding-top:1px}
.sp-detail-pop-foot .sp-link{font-size:10.5px;opacity:.85}
.sp-detail-pop-foot .sp-link:hover{opacity:1}
.sp-detail-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px}
.sp-detail-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sp-detail-toolbar>svg{color:var(--dsw-alias-brand-primary);flex:none}
.sp-detail-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sp-detail-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 20px;display:flex;flex-direction:column;gap:10px}
.sp-detail-block{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px}
.sp-detail-block-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.sp-detail-block-toggle{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;padding:0;cursor:pointer;text-align:left}
.sp-detail-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.sp-detail-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sp-detail-value{font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.sp-detail-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.sp-detail-list{display:flex;flex-direction:column;gap:2px;min-width:0}
.sp-detail-change{display:flex;flex-direction:column;gap:1px;padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.sp-detail-change:first-of-type{border-top:0}
.sp-detail-change-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sp-detail-change-diff{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.sp-detail-archive-row{display:flex;flex-direction:column;gap:1px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer}
.sp-detail-archive-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-detail-archive-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-detail-archive-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-detail-empty{padding:20px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sp-detail-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
`;

    // ------------------------------------------------------------------
    // shared store + section registry
    // ------------------------------------------------------------------

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          state = Object.assign({}, state, patch);
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    const panelStore = createStore({ sessionId: null, open: false, nonce: 0 });
    // Frame-level hover bubble: rendered beside the panel (not inside it) so
    // the panel's rounded overflow can never clip it.
    const tipStore = createStore({ visible: false, title: '', text: '', note: '', rect: null });
    // Lightweight task detail popover: shown beside the row (outside the list)
    // so the tree never grows an inline card.
    const detailStore = createStore({ visible: false, task: null, archived: false, rect: null });
    function hideTip() {
      tipStore.set({ visible: false, title: '', text: '', note: '', rect: null });
    }

    function createRegistry() {
      const definitions = new Map();
      const listeners = new Set();
      let snapshot = [];

      function publish() {
        snapshot = [...definitions.values()].sort((left, right) => (left.order ?? 100) - (right.order ?? 100));
        for (const listener of [...listeners]) listener();
      }

      return {
        version: 1,
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        register(definition) {
          if (definition === null || typeof definition !== 'object' || typeof definition.id !== 'string' || definition.id === '') {
            throw new Error('summaryPanel.register: definition.id must be a non-empty string');
          }
          if (typeof definition.render !== 'function') {
            throw new Error(`summaryPanel.register("${definition.id}"): render must be a function`);
          }
          definitions.set(definition.id, definition);
          publish();
          return () => {
            if (definitions.get(definition.id) === definition) {
              definitions.delete(definition.id);
              publish();
            }
          };
        },
        unregister(id) {
          if (definitions.delete(id)) publish();
        },
      };
    }

    const sectionRegistry = createRegistry();

    function useSnapshot(source) {
      const [snapshot, setSnapshot] = React.useState(() => source.get());
      React.useEffect(() => {
        const unsubscribe = source.subscribe(() => setSnapshot(source.get()));
        setSnapshot(source.get());
        return unsubscribe;
      }, [source]);
      return snapshot;
    }

    function makeT(locale) {
      let bound;
      try {
        bound = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : undefined;
      } catch {
        bound = undefined;
      }
      let active = 'zh';
      try {
        const snapshot = locale !== undefined && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
        if (snapshot !== undefined && typeof snapshot.active === 'string') active = snapshot.active;
      } catch {
        active = 'zh';
      }
      const dict = active === 'en' ? EN : ZH;
      return (key, params) => {
        if (bound !== undefined) {
          try {
            return bound(key, params);
          } catch {
            /* fall through to the local dictionary */
          }
        }
        let text = dict[key] !== undefined ? dict[key] : (ZH[key] !== undefined ? ZH[key] : key);
        if (params !== undefined && params !== null) {
          for (const name of Object.keys(params)) {
            text = text.split(`{${name}}`).join(String(params[name]));
          }
        }
        return text;
      };
    }

    function useT(locale) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => force((value) => value + 1));
      }, [locale]);
      return makeT(locale);
    }

    function relTime(time, t) {
      if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return '';
      const diff = Math.max(0, Date.now() - time);
      if (diff < 60000) return t('time.justNow');
      if (diff < 3600000) return t('time.minutes', { n: Math.floor(diff / 60000) });
      if (diff < 86400000) return t('time.hours', { n: Math.floor(diff / 3600000) });
      if (diff < 7 * 86400000) return t('time.days', { n: Math.floor(diff / 86400000) });
      const date = new Date(time);
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }

    function baseName(path) {
      const parts = String(path).split(/[\\/]/).filter(Boolean);
      return parts.length === 0 ? String(path) : parts[parts.length - 1];
    }

    function depthOf(branch) {
      const depth = String(branch).split('/').length - 1;
      return depth < 0 ? 0 : (depth > 4 ? 4 : depth);
    }

    // ------------------------------------------------------------------
    // data
    // ------------------------------------------------------------------

    function apiUrl(path, params) {
      let url;
      try {
        url = new URL(path, document.baseURI);
      } catch {
        url = new URL(path, window.location.href);
      }
      if (params !== undefined && params !== null) {
        for (const name of Object.keys(params)) {
          const value = params[name];
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
        }
      }
      return url.toString();
    }

    function useSection(sessionId, id, nonce, extra = '') {
      const [state, setState] = React.useState({ status: 'loading' });
      const [local, setLocal] = React.useState(0);
      // Which session the current payload belongs to: a refresh of the same
      // session may keep its data on screen, a different session never does.
      const identity = sessionId === null || sessionId === undefined ? '' : String(sessionId);

      React.useEffect(() => {
        if (sessionId === null || sessionId === undefined) {
          setState({ status: 'idle', identity });
          return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        setState((previous) => (previous.identity === identity && previous.status === 'ready'
          ? Object.assign({}, previous, { refreshing: true })
          : { status: 'loading', identity }));
        let target;
        try {
          target = new URL(`summary-panel/${id}`, document.baseURI);
        } catch {
          target = new URL(`summary-panel/${id}`, window.location.href);
        }
        target.searchParams.set('sessionId', String(sessionId));
        if (extra !== '') {
          for (const [name, value] of new URLSearchParams(extra)) target.searchParams.set(name, value);
        }
        fetch(target.toString(), { signal: controller.signal, credentials: 'same-origin' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((data) => {
            if (!cancelled) setState({ status: 'ready', identity, data, at: Date.now() });
          })
          .catch((error) => {
            if (cancelled) return;
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
            const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
              ? error.message
              : String(error);
            setState((previous) => (previous.identity === identity && previous.status === 'ready'
              ? Object.assign({}, previous, { refreshing: false, message })
              : { status: 'error', message, identity }));
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [sessionId, id, nonce, local, extra]);

      return Object.assign({}, state, {
        retry: () => setLocal((value) => value + 1),
      });
    }

    // Polled read-only data. Failure keeps the last good payload (with a
    // `message` for a lightweight notice) instead of blanking the section.
    function usePolledData(options) {
      const path = options.path;
      const sessionId = options.sessionId;
      const extra = options.extra;
      const interval = options.interval ?? 0;
      const nonce = options.nonce ?? 0;
      const identity = options.identity === undefined || options.identity === null ? '' : String(options.identity);
      const enabled = options.enabled !== false;
      const extraKey = extra === undefined || extra === null ? '' : JSON.stringify(extra);
      const [state, setState] = React.useState({ status: 'loading' });
      const [local, setLocal] = React.useState(0);

      React.useEffect(() => {
        if (!enabled || sessionId === null || sessionId === undefined) {
          setState((previous) => (previous.status === 'idle' && previous.identity === identity
            ? previous
            : { status: 'idle', identity }));
          return undefined;
        }
        let cancelled = false;
        let active = null;
        let timer = null;
        const tick = () => {
          if (cancelled || active !== null) return;
          const controller = new AbortController();
          active = controller;
          setState((previous) => {
            if (previous.identity !== identity) return { status: 'loading', identity };
            if (previous.status === 'ready') return Object.assign({}, previous, { refreshing: true });
            return Object.assign({}, previous, { identity });
          });
          let target;
          try {
            const params = extra === undefined || extra === null ? { sessionId } : Object.assign({ sessionId }, extra);
            target = apiUrl(path, params);
          } catch (error) {
            active = null;
            setState({ status: 'error', message: String(error?.message ?? error), identity });
            return;
          }
          fetch(target, { signal: controller.signal, credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.json();
            })
            .then((data) => {
              if (active === controller) active = null;
              if (cancelled) return;
              setState({ status: 'ready', data, at: Date.now(), identity });
            })
            .catch((error) => {
              if (active === controller) active = null;
              if (cancelled || controller.signal.aborted) return;
              if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
              const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
                ? error.message
                : String(error);
              setState((previous) => {
                if (previous.identity === identity && previous.status === 'ready') {
                  return Object.assign({}, previous, { refreshing: false, message });
                }
                return { status: 'error', message, identity };
              });
            });
        };
        tick();
        if (typeof interval === 'number' && interval > 0) timer = setInterval(tick, interval);
        return () => {
          cancelled = true;
          if (active !== null) {
            active.abort();
            active = null;
          }
          if (timer !== null) clearInterval(timer);
        };
      }, [path, sessionId, extraKey, interval, nonce, identity, enabled, local]);

      return Object.assign({}, state, {
        retry: () => setLocal((value) => value + 1),
      });
    }

    /**
     * The one Session the frame's main view holds, or undefined when it shows
     * something else — for example the new-session welcome page. Each row of the
     * sessions snapshot carries `retainedBy` reference counts.
     */
    function selectMainViewSession(state) {
      const byId = state !== null && typeof state === 'object' ? state.byId : undefined;
      if (byId === null || typeof byId !== 'object') return undefined;
      for (const session of Object.values(byId)) {
        if (session === null || typeof session !== 'object') continue;
        if (Number(session.retainedBy?.mainView ?? 0) > 0) return session.id;
      }
      return undefined;
    }

    /**
     * Follow the Session the frame reports for the main view.
     *
     * The entry button lives in the session header, so it unmounts on the
     * welcome page and cannot report "no session" from there. The overlay keeps
     * receiving the frame's sessions snapshot regardless, which makes it the
     * reliable source; hosts that do not hand the slot that hook fall back to
     * the entry-button behaviour.
     */
    function useMainViewSession(useSessions) {
      // Slot props are fixed for a mounted occupant, and the hook order must not
      // depend on them, so support is decided once per instance.
      const supported = React.useRef(typeof useSessions === 'function').current;
      const id = supported ? useSessions(selectMainViewSession) : undefined;
      return { supported, id: typeof id === 'string' && id !== '' ? id : null };
    }

    // ------------------------------------------------------------------
    // glyphs
    // ------------------------------------------------------------------

    function Glyph(props) {
      const size = props.size ?? 14;
      const name = props.name ?? 'panel';
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      };
      let children = null;
      if (name === 'panel') {
        children = [
          h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h('path', { key: 'b', d: 'M7 9h10M7 13h6' }),
        ];
      } else if (name === 'git') {
        children = [
          h('circle', { key: 'a', cx: 6, cy: 6, r: 2.2 }),
          h('circle', { key: 'b', cx: 6, cy: 18, r: 2.2 }),
          h('circle', { key: 'c', cx: 18, cy: 8, r: 2.2 }),
          h('path', { key: 'd', d: 'M6 8.2v7.6M18 10.2c0 4-4.5 4-9 5' }),
        ];
      } else if (name === 'branch') {
        children = [
          h('circle', { key: 'a', cx: 6, cy: 6, r: 2 }),
          h('circle', { key: 'b', cx: 6, cy: 18, r: 2 }),
          h('circle', { key: 'c', cx: 18, cy: 6, r: 2 }),
          h('path', { key: 'd', d: 'M6 8v8M18 8v2c0 4-4 4-8 5' }),
        ];
      } else if (name === 'refresh') {
        children = [
          h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.3-5.6' }),
          h('path', { key: 'b', d: 'M20 4v4.5h-4.5' }),
        ];
      } else if (name === 'close') {
        children = [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })];
      } else if (name === 'file') {
        children = [
          h('path', { key: 'a', d: 'M7 3h7l4 4v14H7z' }),
          h('path', { key: 'b', d: 'M14 3v4h4' }),
        ];
      } else if (name === 'robot') {
        children = [
          h('rect', { key: 'a', x: 4, y: 8, width: 16, height: 11, rx: 3 }),
          h('path', { key: 'b', d: 'M12 8V5M9 13h.01M15 13h.01' }),
        ];
      } else if (name === 'globe') {
        children = [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 8 }),
          h('path', { key: 'b', d: 'M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16' }),
        ];
      } else if (name === 'chevron-down') {
        children = [h('path', { key: 'a', d: 'M8 10l4 4 4-4' })];
      } else if (name === 'chevron-right') {
        children = [h('path', { key: 'a', d: 'M10 8l4 4-4 4' })];
      } else if (name === 'search') {
        children = [
          h('circle', { key: 'a', cx: 11, cy: 11, r: 6 }),
          h('path', { key: 'b', d: 'M16 16l4 4' }),
        ];
      } else if (name === 'link') {
        children = [
          h('path', { key: 'a', d: 'M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1' }),
          h('path', { key: 'b', d: 'M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1' }),
        ];
      } else if (name === 'tasks') {
        children = [
          h('path', { key: 'a', d: 'M10 6h10M10 12h10M10 18h10' }),
          h('circle', { key: 'b', cx: 4.5, cy: 6, r: 1 }),
          h('circle', { key: 'c', cx: 4.5, cy: 12, r: 1 }),
          h('circle', { key: 'd', cx: 4.5, cy: 18, r: 1 }),
        ];
      } else {
        children = [h('path', { key: 'a', d: 'M14 7l3 3-8 8H6v-3z' })];
      }
      return h('svg', common, children);
    }

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    // ------------------------------------------------------------------
    // sections
    // ------------------------------------------------------------------

    function Skeleton() {
      return h('div', { className: 'sp-stack', 'aria-hidden': true },
        h('div', { className: 'sp-skeleton' }),
        h('div', { className: 'sp-skeleton short' }),
        h('div', { className: 'sp-skeleton' }));
    }

    function SectionCard(props) {
      const [open, setOpen] = React.useState(props.defaultOpen === true);
      const { state, t } = props;
      let body;
      if (state.status === 'error') {
        body = h('div', { className: 'sp-error' },
          h('span', null, t('state.error', { message: state.message ?? '' })),
          h('button', { className: 'sp-link', onClick: state.retry }, t('state.retry')));
      } else if (state.status !== 'ready') {
        body = h(Skeleton, null);
      } else {
        body = props.children();
      }
      return h('section', { className: 'sp-card' },
        h('button', {
          className: 'sp-card-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h(Glyph, { name: props.icon, size: 14 }),
          h('span', { className: 'sp-card-title' }, props.title),
          props.badge !== undefined && props.badge !== null && props.badge !== ''
            ? h('span', { className: 'sp-card-badge', title: String(props.badge) }, props.badge)
            : null,
          state.refreshing ? h('span', { className: 'sp-spin', 'aria-hidden': true }) : null,
          h(Glyph, { name: open ? 'chevron-down' : 'chevron-right', size: 12 })),
        open ? h('div', { className: 'sp-card-body' }, body) : null);
    }

    function statusChips(git, t) {
      const chips = [];
      if (git.dirty.staged > 0) chips.push(h('span', { key: 's', className: 'sp-chip sp-chip-ok' }, t('git.staged', { n: git.dirty.staged })));
      if (git.dirty.modified > 0) chips.push(h('span', { key: 'm', className: 'sp-chip sp-chip-mod' }, t('git.modified', { n: git.dirty.modified })));
      if (git.dirty.untracked > 0) chips.push(h('span', { key: 'u', className: 'sp-chip sp-chip-new' }, t('git.untracked', { n: git.dirty.untracked })));
      if (git.dirty.conflicted > 0) chips.push(h('span', { key: 'c', className: 'sp-chip sp-chip-warn' }, t('git.conflicted', { n: git.dirty.conflicted })));
      if (chips.length === 0) chips.push(h('span', { key: 'clean', className: 'sp-chip sp-chip-ok' }, t('git.clean')));
      return chips;
    }

    function branchRow(branch, depth, label, t) {
      return h('div', {
        key: branch.name,
        className: 'sp-item sp-branch',
        style: { '--depth': String(depth) },
        title: branch.name,
      },
        branch.current
          ? h('span', { className: 'sp-current', 'aria-hidden': true }, '★')
          : h(Glyph, { name: 'branch', size: 12 }),
        h('span', { className: 'sp-item-main' + (branch.current ? ' sp-current' : '') }, label),
        branch.gone ? h('span', { className: 'sp-muted' }, t('git.gone')) : null,
        branch.ahead > 0 ? h('span', { className: 'sp-ahead' }, `↑${branch.ahead}`) : null,
        branch.behind > 0 ? h('span', { className: 'sp-behind' }, `↓${branch.behind}`) : null);
    }

    function SubBlock({ title, badge, children }) {
      const [open, setOpen] = React.useState(false);
      return h('div', { className: 'sp-block' },
        h('button', {
          type: 'button',
          className: 'sp-block-head sp-subblock-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h(Glyph, { name: open ? 'chevron-down' : 'chevron-right', size: 12 }),
          h('span', null, title),
          badge !== undefined && badge !== null ? h('span', { className: 'sp-muted' }, String(badge)) : null),
        open ? children() : null);
    }

    function BranchesBlock({ branches, t }) {
      const [expanded, setExpanded] = React.useState({});
      if (!Array.isArray(branches) || branches.length === 0) return null;

      const current = branches.find((branch) => branch.current);
      const rest = branches.filter((branch) => !branch.current);
      const flat = [];
      const folders = new Map();
      for (const branch of rest) {
        const segments = branch.name.split('/');
        if (segments.length > 1) {
          const key = segments[0];
          if (!folders.has(key)) folders.set(key, []);
          folders.get(key).push({ branch, label: segments.slice(1).join('/') });
        } else {
          flat.push({ branch, label: branch.name });
        }
      }
      const toggle = (key) => setExpanded((previous) => Object.assign({}, previous, { [key]: previous[key] !== true }));

      return h(SubBlock, { title: t('git.branches', { n: branches.length }) }, () => h('div', { className: 'sp-list' },
          current === undefined ? null : branchRow(current, 0, current.name, t),
          flat.map((entry) => branchRow(entry.branch, 0, entry.label, t)),
          [...folders.entries()]
            .sort((left, right) => left[0].localeCompare(right[0]))
            .map(([key, entries]) => h(React.Fragment, { key },
              h('button', {
                type: 'button',
                className: 'sp-folder-row',
                'aria-expanded': expanded[key] === true,
                title: t('git.folderHint', { n: entries.length }),
                onClick: () => toggle(key),
              },
                h(Glyph, { name: expanded[key] === true ? 'chevron-down' : 'chevron-right', size: 12 }),
                h('span', { className: 'sp-folder-name' }, `${key}/`),
                h('span', { className: 'sp-muted' }, String(entries.length)),
                entries.some((entry) => entry.branch.ahead > 0)
                  ? h('span', { className: 'sp-ahead' }, `↑${entries.reduce((sum, entry) => sum + entry.branch.ahead, 0)}`)
                  : null),
              expanded[key] === true
                ? entries.map((entry) => branchRow(entry.branch, 1, entry.label, t))
                : null))));
    }

    function CommitsBlock({ commits, t }) {
      const [all, setAll] = React.useState(false);
      if (!Array.isArray(commits) || commits.length === 0) {
        return h('div', { className: 'sp-empty' }, t('git.noCommits'));
      }
      const shown = all ? commits : commits.slice(0, 8);
      return h(SubBlock, { title: t('git.commits'), badge: commits.length }, () => h('div', { className: 'sp-list' },
          shown.map((commit) => h('div', { key: commit.hash, className: 'sp-commit' },
            h('div', { className: 'sp-commit-line' },
              h('span', { className: 'sp-commit-hash' }, commit.short),
              h('span', { className: 'sp-commit-subject', title: commit.subject }, commit.subject)),
            h('div', { className: 'sp-commit-meta' },
              h('span', null, commit.author || ''),
              commit.time > 0 ? h('span', null, '·') : null,
              commit.time > 0 ? h('span', null, relTime(commit.time, t)) : null,
              Array.isArray(commit.refs) && commit.refs.length > 0
                ? commit.refs.slice(0, 2).map((ref) => h('span', { key: ref, className: 'sp-ref' }, ref))
                : null)))));
    }

    function GitBody({ data, t }) {
      if (data === null || data === undefined) return h('div', { className: 'sp-empty' }, t('state.empty'));
      if (data.available !== true) {
        const message = data.reason === 'not-repository'
          ? t('git.noRepo')
          : data.reason === 'no-cwd' ? t('git.noCwd') : t('state.empty');
        return h('div', { className: 'sp-empty' }, message);
      }
      return h('div', { className: 'sp-stack' },
        h('div', { className: 'sp-repo' },
          h('span', { className: 'sp-repo-name' }, data.repo.name),
          h('span', { className: 'sp-repo-path', title: data.repo.root }, data.repo.root)),
        h('div', { className: 'sp-row' },
          h(Glyph, { name: 'git', size: 13 }),
          h('span', { className: 'sp-branch-name' }, data.branch || '—'),
          data.detached ? h('span', { className: 'sp-chip sp-chip-warn' }, t('git.detached')) : null,
          data.upstream ? h('span', { className: 'sp-muted' }, data.upstream) : null,
          data.ahead > 0 ? h('span', { className: 'sp-ahead' }, `↑${data.ahead}`) : null,
          data.behind > 0 ? h('span', { className: 'sp-behind' }, `↓${data.behind}`) : null),
        h('div', { className: 'sp-row sp-chips' }, statusChips(data, t)),
        h(BranchesBlock, { branches: data.branches, t }),
        h(CommitsBlock, { commits: data.commits, t }));
    }

    function GitSection({ sessionId, nonce, t, isSubagent }) {
      const state = useSection(sessionId, 'git', nonce);
      const data = state.data;
      if (isSubagent && state.status === 'ready' && (data === undefined || data.available !== true)) return null;
      const badge = data !== undefined && data.available === true ? (data.branch || null) : null;
      return h(SectionCard, { icon: 'git', title: t('section.git'), badge, state, t, defaultOpen: true },
        () => h(GitBody, { data, t }));
    }

    function statusLabel(status, t) {
      if (status === 'added') return t('status.added');
      if (status === 'deleted') return t('status.deleted');
      if (status === 'renamed') return t('status.renamed');
      if (status === 'conflicted') return t('status.conflicted');
      if (status === 'untracked') return t('status.untracked');
      return t('status.modified');
    }

    function OutputsBody({ data, t, api, sessionId }) {
      const deliveries = Array.isArray(data?.deliveries) ? data.deliveries : [];
      const workingTree = data?.workingTree ?? null;
      if (deliveries.length === 0 && workingTree === null) {
        return h('div', { className: 'sp-empty' }, t('outputs.empty'));
      }
      const blocks = [];
      if (deliveries.length > 0) {
        blocks.push(h('div', { key: 'deliveries', className: 'sp-block' },
          h('div', { className: 'sp-block-head' },
            h('span', null, t('outputs.deliveries')),
            h('span', { className: 'sp-muted' }, String(deliveries.length))),
          h('div', { className: 'sp-list' },
            deliveries.map((file) => (typeof file.address === 'string' && file.address !== ''
              ? h('button', {
                key: file.path,
                type: 'button',
                className: 'sp-file-row',
                title: file.path,
                onClick: () => api.openSourceFile(file.address),
              },
                h(Glyph, { name: 'file', size: 12 }),
                h('span', { className: 'sp-file-path' }, baseName(file.path)),
                file.description ? h('span', { className: 'sp-item-sub' }, file.description) : null)
              : h('div', { key: file.path, className: 'sp-item', title: file.path },
                h(Glyph, { name: 'file', size: 12 }),
                h('span', { className: 'sp-item-main' }, baseName(file.path)),
                h('span', { className: 'sp-item-sub' }, file.description || file.path)))))));
      }
      if (workingTree === null) {
        blocks.push(h('div', { key: 'tree', className: 'sp-block' },
          h('div', { className: 'sp-block-head' }, h('span', null, t('outputs.workingTree'))),
          h('div', { className: 'sp-empty' }, t('outputs.noRepo'))));
      } else {
        const files = Array.isArray(workingTree.files) ? workingTree.files : [];
        blocks.push(h('div', { key: 'tree', className: 'sp-block' },
          h('div', { className: 'sp-block-head' },
            h('span', null, t('outputs.workingTree')),
            h('span', { className: 'sp-muted' }, files.length > 0 ? t('outputs.count', { n: files.length }) : t('outputs.clean'))),
          files.length > 0
            ? h('div', { className: 'sp-list' },
              files.map((file) => h('button', {
                key: file.path,
                type: 'button',
                className: 'sp-file-row',
                title: file.path,
                onClick: () => api.openDiff(sessionId, file.path),
              },
                h(Glyph, { name: 'file', size: 12 }),
                h('span', { className: 'sp-file-path' }, file.path),
                file.staged ? h('span', { className: 'sp-file-tag' }, t('status.staged')) : null,
                h('span', { className: 'sp-status sp-status-' + file.status }, statusLabel(file.status, t)))))
            : h('div', { className: 'sp-empty' }, t('outputs.clean'))));
      }
      return h('div', { className: 'sp-stack' }, blocks);
    }

    function OutputsSection({ sessionId, nonce, t, api, isSubagent }) {
      const state = useSection(sessionId, 'outputs', nonce);
      const data = state.data;
      if (isSubagent && state.status === 'ready' && data !== undefined
        && (Array.isArray(data.deliveries) ? data.deliveries.length : 0) === 0
        && (data.workingTree === null || data.workingTree === undefined || data.workingTree.total === 0)) return null;
      let badge = null;
      if (data !== undefined) {
        const count = (Array.isArray(data.deliveries) ? data.deliveries.length : 0)
          + (data.workingTree !== null && data.workingTree !== undefined && Array.isArray(data.workingTree.files) ? data.workingTree.files.length : 0);
        if (count > 0) badge = String(count);
      }
      return h(SectionCard, { icon: 'file', title: t('section.outputs'), badge, state, t },
        () => h(OutputsBody, { data, t, api, sessionId }));
    }

    function SubagentsBody({ data, t, api, sessionId }) {
      const children = Array.isArray(data?.children) ? data.children : [];
      if (children.length === 0) return h('div', { className: 'sp-empty' }, t('subagents.empty'));
      return h('div', { className: 'sp-list' },
        children.map((child) => h('button', {
          key: child.id,
          type: 'button',
          className: 'sp-file-row',
          title: child.label || child.id,
          onClick: () => api.openSubagent(sessionId, child),
        },
          h(Glyph, { name: 'robot', size: 12 }),
          h('span', { className: 'sp-item-main' }, child.label || child.id),
          child.running === true
            ? h('span', { className: 'sp-spin', title: t('subagents.running'), 'aria-label': t('subagents.running') })
            : null,
          h('span', { className: 'sp-item-sub' },
            child.mode === 'continuable'
              ? t('subagents.continuable')
              : (child.mode === 'one-shot' ? t('subagents.oneShot') : t('subagents.unknown'))),
          child.createdAt > 0 ? h('span', { className: 'sp-muted' }, relTime(child.createdAt, t)) : null)));
    }

    function SubagentsSection({ sessionId, nonce, t, api, isSubagent }) {
      const state = useSection(sessionId, 'subagents', nonce);
      const data = state.data;
      const count = Array.isArray(data?.children) ? data.children.length : 0;
      if (isSubagent && state.status === 'ready' && count === 0) return null;
      return h(SectionCard, { icon: 'robot', title: t('section.subagents'), badge: count > 0 ? String(count) : null, state, t },
        () => h(SubagentsBody, { data, t, api, sessionId }));
    }

    function SourcesBody({ data, t, scope, api }) {
      const links = Array.isArray(data?.links) ? data.links : [];
      const queries = Array.isArray(data?.queries) ? data.queries : [];
      const files = Array.isArray(data?.files) ? data.files : [];
      const tools = Array.isArray(data?.tools) ? data.tools : [];
      if (links.length === 0 && queries.length === 0 && files.length === 0 && tools.length === 0) {
        return h('div', { className: 'sp-empty' }, scope === 'turn' ? t('sources.emptyTurn') : t('sources.empty'));
      }
      const groups = [];
      if (links.length > 0) {
        groups.push(h('div', { key: 'links', className: 'sp-block' },
          h('div', { className: 'sp-block-head' },
            h('span', null, t('sources.web')),
            h('span', { className: 'sp-muted' }, String(links.length))),
          h('div', { className: 'sp-list' },
            links.slice(0, 10).map((entry) => h('button', {
              key: entry.url,
              type: 'button',
              className: 'sp-file-row',
              title: entry.url,
              onClick: () => api.openSourceUrl(entry.url),
            },
              h(Glyph, { name: 'link', size: 12 }),
              h('span', { className: 'sp-file-path' }, entry.title || entry.url),
              entry.title !== null && entry.title !== undefined
                ? h('span', { className: 'sp-file-tag' }, '↗')
                : null)))));
      }
      if (queries.length > 0) {
        groups.push(h('div', { key: 'queries', className: 'sp-block' },
          h('div', { className: 'sp-block-head' },
            h('span', null, t('sources.queries')),
            h('span', { className: 'sp-muted' }, String(queries.length))),
          h('div', { className: 'sp-list' },
            queries.slice(0, 8).map((entry) => h('div', { key: entry.value, className: 'sp-item', title: entry.value },
              h(Glyph, { name: 'search', size: 12 }),
              h('span', { className: 'sp-item-main' }, entry.value),
              h('span', { className: 'sp-item-sub' }, t('sources.search')))))));
      }
      if (files.length > 0) {
        groups.push(h('div', { key: 'files', className: 'sp-block' },
          h('div', { className: 'sp-block-head' },
            h('span', null, t('sources.files')),
            h('span', { className: 'sp-muted' }, String(files.length))),
          h('div', { className: 'sp-list' },
            files.slice(0, 10).map((entry) => (typeof entry.address === 'string' && entry.address !== ''
              ? h('button', {
                key: entry.path,
                type: 'button',
                className: 'sp-file-row',
                title: entry.path,
                onClick: () => api.openSourceFile(entry.address),
              },
                h(Glyph, { name: 'file', size: 12 }),
                h('span', { className: 'sp-file-path' }, entry.path))
              : h('div', { key: entry.path, className: 'sp-item', title: entry.path },
                h(Glyph, { name: 'file', size: 12 }),
                h('span', { className: 'sp-item-main' }, entry.path)))))));
      }
      if (tools.length > 0) {
        groups.push(h('div', { key: 'tools', className: 'sp-block' },
          h('div', { className: 'sp-block-head' }, h('span', null, t('sources.tools'))),
          h('div', { className: 'sp-row sp-chips' },
            tools.map((entry) => h('span', { key: entry.name, className: 'sp-chip' }, `${entry.name} ${entry.count}`)))));
      }
      return h('div', { className: 'sp-stack' }, groups);
    }

    function SourcesSection({ sessionId, nonce, t, api, isSubagent }) {
      const [scope, setScope] = React.useState('turn');
      const state = useSection(sessionId, 'sources', nonce, `&scope=${scope}`);
      const data = state.data;
      let badge = null;
      if (data !== undefined) {
        const count = (Array.isArray(data.links) ? data.links.length : 0)
          + (Array.isArray(data.queries) ? data.queries.length : 0)
          + (Array.isArray(data.files) ? data.files.length : 0)
          + (Array.isArray(data.tools) ? data.tools.length : 0);
        if (count > 0) badge = String(count);
      }
      const total = data === undefined
        ? 0
        : (Array.isArray(data.links) ? data.links.length : 0)
          + (Array.isArray(data.queries) ? data.queries.length : 0)
          + (Array.isArray(data.files) ? data.files.length : 0)
          + (Array.isArray(data.tools) ? data.tools.length : 0);
      if (isSubagent && state.status === 'ready' && total === 0) return null;
      const footer = data !== undefined
        ? h('div', { className: 'sp-block-head' },
          h('span', { className: 'sp-muted' }, scope === 'turn'
            ? (typeof data.turn === 'number' ? t('sources.turnLabel', { n: data.turn }) : '')
            : t('sources.wholeSession')),
          h('button', {
            className: 'sp-link',
            onClick: () => setScope(scope === 'turn' ? 'session' : 'turn'),
          }, scope === 'turn' ? t('sources.showAll') : t('sources.showTurn')))
        : null;
      return h(SectionCard, { icon: 'globe', title: t('section.sources'), badge, state, t },
        () => h('div', { className: 'sp-stack' },
          h(SourcesBody, { data, t, scope, api }),
          footer));
    }

    function ExternalSection({ definition, sessionId, nonce, t, locale, api }) {
      const [open, setOpen] = React.useState(true);
      let content = null;
      try {
        content = definition.render({ sessionId, nonce, t, locale, api });
      } catch (error) {
        content = h('div', { className: 'sp-error' }, String(error?.message ?? error));
      }
      return h('section', { className: 'sp-card' },
        h('button', {
          className: 'sp-card-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h(Glyph, { name: definition.icon || 'panel', size: 14 }),
          h('span', { className: 'sp-card-title' }, definition.title || definition.id),
          definition.badge !== undefined && definition.badge !== null && definition.badge !== ''
            ? h('span', { className: 'sp-card-badge' }, String(definition.badge))
            : null,
          h(Glyph, { name: open ? 'chevron-down' : 'chevron-right', size: 12 })),
        open ? h('div', { className: 'sp-card-body' }, content) : null);
    }

    // ------------------------------------------------------------------
    // tasks section (floating panel)
    // ------------------------------------------------------------------

    function taskChildrenMap(tasks) {
      const map = new Map();
      for (const task of tasks) {
        const parentId = task.parentId === null || task.parentId === undefined ? null : String(task.parentId);
        if (!map.has(parentId)) map.set(parentId, []);
        map.get(parentId).push(task);
      }
      for (const list of map.values()) {
        list.sort((left, right) => {
          const orderDiff = (left.order ?? 0) - (right.order ?? 0);
          if (orderDiff !== 0) return orderDiff;
          return String(left.id).localeCompare(String(right.id));
        });
      }
      return map;
    }

    function taskRoots(tasks, childrenMap) {
      const ids = new Set(tasks.map((task) => task.id));
      const roots = tasks.filter((task) => task.parentId === null || task.parentId === undefined || !ids.has(task.parentId));
      roots.sort((left, right) => {
        const orderDiff = (left.order ?? 0) - (right.order ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return String(left.id).localeCompare(String(right.id));
      });
      return roots;
    }

    // Expand the ancestor chain of every focus task, so focus rows are visible
    // without expanding the rest of the tree.
    function focusAncestors(focus, tasks) {
      const map = new Map();
      for (const task of tasks) map.set(task.id, task);
      const expanded = {};
      for (const id of focus) {
        let cursor = map.get(id);
        let guard = 0;
        while (cursor !== undefined && guard < 500) {
          guard += 1;
          const parentId = cursor.parentId === null || cursor.parentId === undefined ? null : String(cursor.parentId);
          if (parentId === null) break;
          expanded[parentId] = true;
          cursor = map.get(parentId);
        }
      }
      return expanded;
    }

    // Number of unfinished (non-done, non-archived) descendants per ancestor.
    // A completed parent can still receive new unfinished children later; the
    // count lets the tree keep them visible instead of hiding them behind a
    // collapsed completed node.
    function unfinishedByAncestor(tasks) {
      const byId = new Map();
      for (const task of tasks) byId.set(task.id, task);
      const counts = new Map();
      for (const task of tasks) {
        if (task.archived === true || task.status === 'done') continue;
        let cursor = task.parentId;
        const seen = new Set();
        while (typeof cursor === 'string' && !seen.has(cursor)) {
          seen.add(cursor);
          counts.set(cursor, (counts.get(cursor) ?? 0) + 1);
          const parent = byId.get(cursor);
          cursor = parent === undefined ? null : parent.parentId;
        }
      }
      return counts;
    }

    function tooltipStyle(rect, options = {}) {
      const width = 240;
      const margin = 8;
      const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 768;
      let left = margin;
      let top = margin;
      if (rect !== null && rect !== undefined) {
        top = rect.bottom + 6;
        if (top > viewportHeight - 120) top = Math.max(margin, rect.top - 6 - 90);
        if (options.center === true) {
          // Center under the anchor; the bubble translates itself by -50%.
          const half = 110;
          const center = rect.left + rect.width / 2;
          left = Math.min(Math.max(center, margin + half), Math.max(margin + half, viewportWidth - margin - half));
          return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, transform: 'translateX(-50%)' };
        }
        left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
      }
      return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
    }

    // Linear/VS Code-flavoured status glyphs: one 12px mark per row, coloured by
    // the existing status model and deliberately quiet for completed work.
    function TaskStatusIcon({ status }) {
      const className = 'sp-task-icon sp-task-icon-' + String(status ?? 'pending');
      const svg = (children) => h('svg', {
        className,
        width: 12,
        height: 12,
        viewBox: '0 0 12 12',
        'aria-hidden': true,
        focusable: 'false',
      }, children);
      if (status === 'done') {
        return svg([
          h('circle', { key: 'bg', cx: 6, cy: 6, r: 5, fill: 'currentColor', opacity: '0.16' }),
          h('path', {
            key: 'check', d: 'M3.7 6.1l1.6 1.6 3.1-3.2', fill: 'none', stroke: 'currentColor',
            strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
        ]);
      }
      if (status === 'blocked') {
        return svg([
          h('circle', { key: 'ring', cx: 6, cy: 6, r: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: '1.3' }),
          h('path', { key: 'bar', d: 'M6 3.7v2.7', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' }),
          h('circle', { key: 'dot', cx: 6, cy: 8.2, r: '0.6', fill: 'currentColor' }),
        ]);
      }
      if (status === 'in_progress') {
        return svg([
          h('circle', { key: 'halo', cx: 6, cy: 6, r: 4.8, fill: 'currentColor', opacity: '0.18' }),
          h('circle', { key: 'core', cx: 6, cy: 6, r: 2.9, fill: 'currentColor' }),
        ]);
      }
      return svg([
        h('circle', { key: 'ring', cx: 6, cy: 6, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', opacity: '0.75' }),
      ]);
    }

    function TasksBody({ data, state, sessionId, t, api }) {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const focus = Array.isArray(data.focus) ? data.focus.filter((id) => typeof id === 'string' && id !== '') : [];
      const focusKey = focus.join('|');
      const focusSet = new Set(focus);
      const [expanded, setExpanded] = React.useState({});
      const hoverTimer = React.useRef(null);
      const initRef = React.useRef({ sessionId: null, focusKey: null, attentionKey: null });
      const unfinishedCounts = unfinishedByAncestor(tasks);
      const attentionIds = tasks
        .filter((task) => task.status === 'done' && (unfinishedCounts.get(task.id) ?? 0) > 0)
        .map((task) => task.id);
      const attentionKey = attentionIds.slice().sort().join('|');

      // Default fold: first load of a session expands only focus ancestors.
      // Completed parents with new unfinished children are also opened once, so
      // their follow-up work is never invisible. Polling refreshes keep the
      // user's manual fold state; a session switch resets to the default.
      React.useEffect(() => {
        if (sessionId === null || sessionId === undefined) return;
        const previous = initRef.current;
        const sessionChanged = previous.sessionId !== sessionId;
        const focusChanged = previous.focusKey !== focusKey;
        const attentionChanged = previous.attentionKey !== attentionKey;
        if (!sessionChanged && !focusChanged && !attentionChanged) return;
        const next = focusAncestors(focus, tasks);
        for (const id of attentionIds) {
          next[id] = true;
          let cursor = tasks.find((task) => task.id === id);
          while (cursor !== undefined && cursor.parentId !== null) {
            next[cursor.parentId] = true;
            cursor = tasks.find((task) => task.id === cursor.parentId);
          }
        }
        initRef.current = { sessionId, focusKey, attentionKey };
        if (sessionChanged) setExpanded(next);
        else setExpanded((current) => Object.assign({}, current, next));
      }, [sessionId, focusKey, attentionKey, tasks]);

      React.useEffect(() => () => {
        if (hoverTimer.current !== null) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
      }, []);

      // Keep an open detail popover in sync with polling data. This hook must
      // stay above the early returns: an empty tree renders fewer hooks than a
      // populated one, and React aborts the whole panel on that mismatch.
      React.useEffect(() => {
        const current = detailStore.get();
        if (current.visible !== true || current.archived === true || current.task === null) return;
        const latest = tasks.find((task) => task.id === current.task.id);
        if (latest === undefined) {
          detailStore.set({ visible: false, task: null, archived: false, rect: null });
          return;
        }
        if (latest.updatedAt === current.task.updatedAt) return;
        detailStore.set(Object.assign({}, current, { task: latest }));
      }, [tasks]);

      if (data.available !== true) return h('div', { className: 'sp-empty' }, t('tasks.unavailable'));
      if (tasks.length === 0) return h('div', { className: 'sp-empty' }, t('tasks.empty'));

      const childrenMap = taskChildrenMap(tasks);
      const roots = taskRoots(tasks, childrenMap);

      const clearHover = () => {
        if (hoverTimer.current !== null) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
        hideTip();
      };
      const enterRow = (task) => (event) => {
        if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
        const element = event.currentTarget;
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          let rect = null;
          try {
            rect = element.getBoundingClientRect();
          } catch {
            rect = null;
          }
          const note = task.status === 'blocked' && task.blocker !== null && task.blocker !== undefined
            && typeof task.blocker.reason === 'string' && task.blocker.reason !== ''
            ? t('tasks.tip.blocker', { reason: task.blocker.reason })
            : '';
          tipStore.set({
            visible: true,
            title: typeof task.title === 'string' ? task.title : '',
            text: typeof task.summary === 'string' ? task.summary : '',
            note,
            rect,
          });
        }, 250);
      };
      const openTask = (task, event) => {
        clearHover();
        let rect = null;
        try {
          rect = event.currentTarget.getBoundingClientRect();
        } catch {
          rect = null;
        }
        api.showTaskDetail({ task, archived: false, rect });
      };
      const toggle = (taskId) => {
        api.closeTaskDetail();
        setExpanded((current) => Object.assign({}, current, { [taskId]: current[taskId] !== true }));
      };

      const rows = [];
      const walk = (task, depth) => {
        const children = childrenMap.get(task.id) ?? [];
        const hasChildren = children.length > 0;
        const doneChildren = children.filter((child) => child.status === 'done').length;
        // A completed task that gained unfinished children is not complete any
        // more: its acceptance record stays, but the row shows it as unfinished
        // until the subtree settles. Hosts that do not send `settled` fall back
        // to counting unfinished descendants.
        const unsettled = task.settled === undefined
          ? (unfinishedCounts.get(task.id) ?? 0) > 0
          : task.settled !== true;
        const completed = task.status === 'done' && !unsettled;
        const shownStatus = completed ? 'done' : (task.status === 'done' ? 'in_progress' : task.status);
        // Keep the panel quiet: only show progress when it carries information.
        const showProgress = hasChildren && (children.length > 1 || (task.status === 'done' && doneChildren < children.length));
        // An idea waiting for the user's go-ahead is the only state the marker
        // adds: anything already started or finished was evidently approved.
        const showApproval = task.executionApproval === 'pending'
          && task.status === 'pending'
          && task.deferred !== true;
        // The worker session behind this execution cannot be resolved any more:
        // the task still records who held it, but nobody has permission until a
        // Lead force-releases it (design v8 I16, ticket #10).
        const showLost = task.executorLost === true;
        const isOpen = expanded[task.id] === true;
        const guides = [];
        for (let level = 0; level < depth; level += 1) {
          guides.push(h('span', { key: `guide-${level}`, className: 'sp-task-guide', 'aria-hidden': true }));
        }
        rows.push(h('div', {
          key: task.id,
          className: 'sp-task-row'
            + (hasChildren ? ' sp-task-row-parent' : '')
            + (completed ? ' sp-task-row-done' : '')
            + (focusSet.has(task.id) ? ' sp-task-row-focus' : '')
            + (task.deferred === true ? ' sp-task-row-deferred' : ''),
          role: 'treeitem',
          'aria-level': depth + 1,
          'aria-expanded': hasChildren ? isOpen : undefined,
        },
          guides,
          hasChildren
            ? h('button', {
              type: 'button',
              className: 'sp-task-arrow',
              title: isOpen ? t('tasks.collapse') : t('tasks.expand'),
              'aria-label': isOpen ? t('tasks.collapse') : t('tasks.expand'),
              onClick: () => toggle(task.id),
            }, h(Glyph, { name: isOpen ? 'chevron-down' : 'chevron-right', size: 11 }))
            : h('span', { className: 'sp-task-arrow-space', 'aria-hidden': true }),
          h('button', {
            type: 'button',
            className: 'sp-task-main',
            title: typeof task.title === 'string' ? task.title : '',
            onClick: (event) => openTask(task, event),
            onMouseEnter: enterRow(task),
            onMouseLeave: clearHover,
          },
            h(TaskStatusIcon, { status: shownStatus }),
            h('span', { className: 'sp-task-title' }, task.title),
            showApproval
              ? h('span', { className: 'sp-task-approval', title: t('tasks.tip.approval') }, t('tasks.approvalPending'))
              : null,
            showLost
              ? h('span', { className: 'sp-task-lost', title: t('tasks.tip.executorLost') }, t('tasks.detail.ownerLost'))
              : null,
            showProgress
              ? h('span', {
                className: 'sp-task-progress'
                  + (task.status === 'done' && (unfinishedCounts.get(task.id) ?? 0) > 0 ? ' sp-task-progress-warn' : ''),
                title: t('tasks.childrenProgress', { done: doneChildren, total: children.length }),
              }, `${doneChildren}/${children.length}`)
              : null)));
        if (isOpen) for (const child of children) walk(child, depth + 1);
      };
      for (const root of roots) walk(root, 0);

      return h('div', { className: 'sp-stack' },
        state.message
          ? h('div', { className: 'sp-error' },
            h('span', null, t('state.error', { message: state.message })),
            h('button', { className: 'sp-link', onClick: state.retry }, t('state.retry')))
          : null,
        h('div', { className: 'sp-task-tree', role: 'tree' }, rows));
    }

    function TasksSection({ sessionId, nonce, t, api }) {
      const identity = sessionId === null || sessionId === undefined ? '' : String(sessionId);
      const state = usePolledData({
        path: 'summary-panel/tasks',
        sessionId,
        interval: 1500,
        nonce,
        identity,
      });
      const ready = state.status === 'ready' && state.identity === identity;
      const data = ready ? state.data : undefined;
      const cardState = ready
        ? Object.assign({}, state, { refreshing: false })
        : { status: state.status === 'error' ? 'error' : 'loading', message: state.message, retry: state.retry };
      return h(SectionCard, { icon: 'tasks', title: t('section.tasks'), state: cardState, t, defaultOpen: true },
        () => h(TasksBody, { data, state, sessionId, t, api }));
    }

    // ------------------------------------------------------------------
    // live diff tab (right sidebar)
    // ------------------------------------------------------------------

    function parseDiffLines(text) {
      const rows = [];
      const lines = String(text).split('\n');
      let oldLine = 0;
      let newLine = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (match !== null) {
            oldLine = Number(match[1]);
            newLine = Number(match[2]);
          }
          rows.push({ type: 'hunk', text: line });
          continue;
        }
        if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ')
          || line.startsWith('+++ ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')
          || line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to')
          || line.startsWith('old mode') || line.startsWith('new mode')) {
          continue;
        }
        if (line === '') {
          if (index === lines.length - 1) continue;
          rows.push({ type: 'meta', text: '' });
          continue;
        }
        if (line.startsWith('\\')) {
          rows.push({ type: 'meta', text: line });
          continue;
        }
        const sign = line[0];
        if (sign === '+') {
          rows.push({ type: 'add', old: null, new: newLine, text: line.slice(1) });
          newLine += 1;
        } else if (sign === '-') {
          rows.push({ type: 'del', old: oldLine, new: null, text: line.slice(1) });
          oldLine += 1;
        } else {
          rows.push({ type: 'ctx', old: oldLine, new: newLine, text: line.slice(1) });
          oldLine += 1;
          newLine += 1;
        }
      }
      return rows;
    }

    function toSideBySide(rows) {
      const pairs = [];
      let index = 0;
      while (index < rows.length) {
        const row = rows[index];
        if (row.type === 'hunk' || row.type === 'meta') {
          pairs.push({ type: row.type, text: row.text });
          index += 1;
          continue;
        }
        if (row.type === 'ctx') {
          pairs.push({ type: 'pair', left: row, right: row });
          index += 1;
          continue;
        }
        const removed = [];
        const added = [];
        while (index < rows.length && rows[index].type === 'del') {
          removed.push(rows[index]);
          index += 1;
        }
        while (index < rows.length && rows[index].type === 'add') {
          added.push(rows[index]);
          index += 1;
        }
        const count = Math.max(removed.length, added.length);
        for (let offset = 0; offset < count; offset += 1) {
          pairs.push({ type: 'pair', left: removed[offset] ?? null, right: added[offset] ?? null });
        }
      }
      return pairs;
    }

    function diffSplitRow(pair, index, side) {
      if (pair.type === 'hunk') return h('div', { key: index, className: 'sp-diff-hunk sp-diff-span' }, pair.text);
      if (pair.type === 'meta') return h('div', { key: index, className: 'sp-diff-meta sp-diff-span' }, pair.text);
      const row = side === 'left' ? pair.left : pair.right;
      const hasRow = row !== null && row !== undefined;
      const removed = hasRow && row.type === 'del';
      const added = hasRow && row.type === 'add';
      return h('div', {
        key: index,
        className: 'sp-diff-row'
          + (side === 'left' && removed ? ' sp-diff-del' : '')
          + (side === 'right' && added ? ' sp-diff-add' : ''),
      },
        h('span', { className: 'sp-diff-num' }, hasRow ? String(side === 'left' ? row.old ?? '' : row.new ?? '') : ''),
        h('span', { className: 'sp-diff-sign' }, hasRow ? (removed ? '−' : (added ? '+' : ' ')) : ' '),
        h('span', { className: 'sp-diff-text' }, hasRow && row.text !== '' ? row.text : ' '));
    }

    function DiffBody({ sessionId, useTabInfo, t }) {
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
      const tab = info === undefined ? undefined : info.tab;
      const params = tab === undefined ? undefined : tab.navigation?.params;
      const path = params !== undefined && typeof params.path === 'string' ? params.path : '';
      const targetSession = params !== undefined && typeof params.sessionId === 'string'
        ? params.sessionId
        : (typeof sessionId === 'string' ? sessionId : undefined);
      const revision = tab === undefined ? 0 : (tab.navigation?.revision ?? 0);
      const visible = tab === undefined ? true : tab.visible !== false;
      const [attempt, setAttempt] = React.useState(0);
      const [layout, setLayout] = React.useState('unified');
      const [state, setState] = React.useState({ status: 'loading' });
      const leftPaneRef = React.useRef(null);
      const rightPaneRef = React.useRef(null);
      const scrollLockRef = React.useRef(false);
      const syncScroll = (targetRef) => (event) => {
        if (scrollLockRef.current) return;
        const target = targetRef.current;
        if (target === null) return;
        scrollLockRef.current = true;
        target.scrollTop = event.currentTarget.scrollTop;
        target.scrollLeft = event.currentTarget.scrollLeft;
        const unlock = () => { scrollLockRef.current = false; };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(unlock);
        else setTimeout(unlock, 0);
      };

      React.useEffect(() => {
        if (targetSession === undefined || path === '') {
          setState({ status: 'empty' });
          return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        setState((previous) => (previous.status === 'ready'
          ? Object.assign({}, previous, { refreshing: true })
          : { status: 'loading' }));
        fetch(apiUrl('summary-panel/diff', { sessionId: targetSession, path }), {
          signal: controller.signal,
          credentials: 'same-origin',
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((data) => {
            if (!cancelled) setState({ status: 'ready', data, at: Date.now() });
          })
          .catch((error) => {
            if (cancelled) return;
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
            setState({ status: 'error', message: String(error?.message ?? error) });
          });
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [targetSession, path, revision, attempt, visible]);

      let body;
      if (path === '') {
        body = h('div', { className: 'sp-diff-empty' }, t('diff.noTarget'));
      } else if (state.status === 'loading' || state.status === 'empty') {
        body = h('div', { className: 'sp-diff-empty' }, h('span', { className: 'sp-spin' }), t('state.loading'));
      } else if (state.status === 'error') {
        body = h('div', { className: 'sp-diff-empty' },
          t('state.error', { message: state.message ?? '' }),
          h('button', { className: 'sp-link', onClick: () => setAttempt((value) => value + 1) }, t('state.retry')));
      } else {
        const data = state.data;
        if (data === undefined || data.available !== true) {
          body = h('div', { className: 'sp-diff-empty' },
            data !== undefined && data.reason === 'bad-path' ? t('diff.badPath') : t('diff.unavailable'));
        } else if (data.binary) {
          body = h('div', { className: 'sp-diff-empty' }, t('diff.binary'));
        } else if (typeof data.diff !== 'string' || data.diff === '') {
          body = h('div', { className: 'sp-diff-empty' }, t('diff.empty'));
        } else {
          const rows = parseDiffLines(data.diff);
          const notice = data.truncated
            ? h('div', { className: 'sp-diff-notice' }, t('diff.truncated', { n: rows.length }))
            : null;
          if (layout === 'split') {
            const pairs = toSideBySide(rows);
            body = h('div', { className: 'sp-diff-split-wrap' },
              notice,
              h('div', { className: 'sp-diff-body sp-diff-body-split' },
                h('div', { className: 'sp-split-pane', ref: leftPaneRef, onScroll: syncScroll(rightPaneRef) },
                  h('div', { className: 'sp-split-content' },
                    pairs.map((pair, index) => diffSplitRow(pair, index, 'left')))),
                h('div', { className: 'sp-split-pane', ref: rightPaneRef, onScroll: syncScroll(leftPaneRef) },
                  h('div', { className: 'sp-split-content' },
                    pairs.map((pair, index) => diffSplitRow(pair, index, 'right'))))));
          } else {
            body = h('div', { className: 'sp-diff-body' },
              notice,
              h('div', { className: 'sp-diff-table' },
                rows.map((row, index) => {
                  if (row.type === 'hunk') return h('div', { key: index, className: 'sp-diff-hunk' }, row.text);
                  if (row.type === 'meta') return h('div', { key: index, className: 'sp-diff-meta' }, row.text);
                  return h('div', { key: index, className: 'sp-diff-row sp-diff-' + row.type },
                    h('span', { className: 'sp-diff-num' }, row.old === null ? '' : String(row.old)),
                    h('span', { className: 'sp-diff-num' }, row.new === null ? '' : String(row.new)),
                    h('span', { className: 'sp-diff-sign' }, row.type === 'add' ? '+' : (row.type === 'del' ? '−' : ' ')),
                    h('span', { className: 'sp-diff-text' }, row.text === '' ? ' ' : row.text));
                })));
          }
        }
      }

      return h('div', { className: 'sp-diff-root' },
        h(Styles, null),
        h('div', { className: 'sp-diff-toolbar' },
          h(Glyph, { name: 'file', size: 14 }),
          h('span', { className: 'sp-diff-path', title: path }, path === '' ? t('diff.noTarget') : path),
          state.status === 'ready' && state.data !== undefined && state.data.untracked === true
            ? h('span', { className: 'sp-status sp-status-untracked' }, t('status.untracked'))
            : null,
          state.status === 'ready' && state.data !== undefined && typeof state.data.diff === 'string' && state.data.diff !== ''
            ? h('button', {
              className: 'sp-link',
              title: t('diff.layoutHint'),
              onClick: () => setLayout(layout === 'split' ? 'unified' : 'split'),
            }, layout === 'split' ? t('diff.unified') : t('diff.split'))
            : null,
          h('button', {
            className: 'sp-icon-btn',
            title: t('diff.refresh'),
            'aria-label': t('diff.refresh'),
            onClick: () => setAttempt((value) => value + 1),
          }, h(Glyph, { name: 'refresh', size: 13 }))),
        body);
    }

    // ------------------------------------------------------------------
    // task detail tab (right sidebar)
    // ------------------------------------------------------------------

    function taskStatusText(status, t) {
      if (status === 'in_progress') return t('tasks.status.inProgress');
      if (status === 'blocked') return t('tasks.status.blocked');
      if (status === 'done') return t('tasks.status.done');
      return t('tasks.status.pending');
    }

    function taskCompletionText(completion, t) {
      if (completion === 'user-confirmed') return t('tasks.detail.completionUser');
      if (completion === 'self') return t('tasks.detail.completionSelf');
      return '';
    }

    function detailValueText(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    function DetailField({ label, value, mono }) {
      return h('div', { className: 'sp-detail-field' },
        h('div', { className: 'sp-detail-label' }, label),
        h('div', { className: 'sp-detail-value' + (mono === true ? ' sp-detail-mono' : '') }, detailValueText(value)));
    }

    function TaskDetailBody(props) {
      const { sessionId, useTabInfo, t, api } = props;
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined;
      const tab = info === undefined ? undefined : info.tab;
      const params = tab === undefined ? undefined : tab.navigation?.params;
      const taskId = params !== undefined && typeof params.taskId === 'string' ? params.taskId : '';
      const targetSession = params !== undefined && typeof params.sessionId === 'string'
        ? params.sessionId
        : (typeof sessionId === 'string' ? sessionId : undefined);
      const revision = tab === undefined ? 0 : (tab.navigation?.revision ?? 0);
      const visible = tab === undefined ? true : tab.visible !== false;
      const identity = `${targetSession ?? ''}\u0000${taskId}`;
      const [archivedOpen, setArchivedOpen] = React.useState(false);
      const state = usePolledData({
        path: 'summary-panel/tasks',
        sessionId: targetSession,
        interval: 3000,
        nonce: revision,
        identity,
        enabled: visible && taskId !== '' && targetSession !== undefined,
      });
      const ready = state.status === 'ready' && state.identity === identity;
      const data = ready ? state.data : undefined;
      const tasks = data !== undefined && Array.isArray(data.tasks) ? data.tasks : [];
      const archived = data !== undefined && Array.isArray(data.archived) ? data.archived : [];
      const active = taskId === ''
        ? undefined
        : tasks.find((task) => task !== null && typeof task === 'object' && task.id === taskId);
      const archivedEntry = active === undefined && taskId !== ''
        ? archived.find((entry) => entry !== null && typeof entry === 'object' && entry.id === taskId)
        : undefined;

      let body;
      if (taskId === '') {
        body = h('div', { className: 'sp-detail-empty' }, t('tasks.detail.noTarget'));
      } else if (!ready && state.status === 'error') {
        body = h('div', { className: 'sp-detail-empty' },
          t('state.error', { message: state.message ?? '' }),
          h('button', { className: 'sp-link', onClick: state.retry }, t('state.retry')));
      } else if (!ready) {
        body = h('div', { className: 'sp-detail-empty' }, h('span', { className: 'sp-spin' }), t('state.loading'));
      } else if (data === undefined || data.available !== true) {
        body = h('div', { className: 'sp-detail-empty' }, t('tasks.unavailable'));
      } else if (active === undefined && archivedEntry === undefined) {
        body = h('div', { className: 'sp-detail-empty' }, t('tasks.detail.missing'));
      } else {
        const blocks = [];
        const goal = data.goal === undefined ? null : data.goal;
        if (goal !== null && goal !== undefined) {
          const changes = Array.isArray(goal.changes) ? goal.changes : [];
          blocks.push(h('section', { key: 'goal', className: 'sp-detail-block' },
            h('div', { className: 'sp-detail-block-title' }, t('tasks.detail.goal')),
            h(DetailField, { label: t('tasks.detail.original'), value: goal.original }),
            h(DetailField, { label: t('tasks.detail.current'), value: goal.current }),
            typeof data.outline === 'string' && data.outline !== ''
              ? h(DetailField, { label: t('tasks.detail.outline'), value: data.outline })
              : null,
            changes.length > 0
              ? h('div', { className: 'sp-detail-field' },
                h('div', { className: 'sp-detail-label' }, t('tasks.detail.changes', { n: changes.length })),
                h('div', { className: 'sp-detail-list' },
                  changes.map((change, index) => h('div', { key: `${String(change.at)}-${index}`, className: 'sp-detail-change' },
                    h('div', { className: 'sp-detail-change-meta' }, `${relTime(change.at, t)} · ${String(change.reason ?? '')}`),
                    h('div', { className: 'sp-detail-change-diff' }, `${String(change.previous ?? '')} → ${String(change.next ?? '')}`)))))
              : null));
        }

        if (active !== undefined) {
          const fields = [];
          fields.push(h('div', { key: 'status', className: 'sp-detail-field' },
            h('div', { className: 'sp-detail-label' }, t('tasks.detail.status')),
            h('div', { className: 'sp-detail-value' },
              h('span', { className: 'sp-task-status sp-task-status-' + String(active.status ?? 'pending') }, taskStatusText(active.status, t)),
              active.status === 'done' && active.settled === false
                ? h('span', { className: 'sp-task-status sp-task-status-in_progress' }, t('tasks.detail.subtreePending'))
                : null,
              active.deferred === true
                ? h('span', { className: 'sp-task-status sp-task-status-deferred' }, t('tasks.deferred'))
                : null)));
          fields.push(h(DetailField, {
            key: 'approval',
            label: t('tasks.detail.approval'),
            value: active.executionApproval === 'approved'
              ? t('tasks.detail.approvalApproved')
              : t('tasks.detail.approvalPending'),
          }));
          if (typeof active.approvalBasis === 'string' && active.approvalBasis !== '') {
            fields.push(h(DetailField, { key: 'approvalBasis', label: t('tasks.detail.approvalBasis'), value: active.approvalBasis }));
          }
          fields.push(h(DetailField, {
            key: 'acceptance',
            label: t('tasks.detail.acceptance'),
            value: active.requiresUserAcceptance === false
              ? t('tasks.detail.acceptanceOptional')
              : t('tasks.detail.acceptanceRequired'),
          }));
          if (typeof active.acceptanceBasis === 'string' && active.acceptanceBasis !== '') {
            fields.push(h(DetailField, { key: 'acceptanceBasis', label: t('tasks.detail.acceptanceBasis'), value: active.acceptanceBasis }));
          }
          if (typeof active.summary === 'string' && active.summary !== '') {
            fields.push(h(DetailField, { key: 'summary', label: t('tasks.detail.summary'), value: active.summary }));
          }
          if (typeof active.progress === 'string' && active.progress !== '') {
            fields.push(h(DetailField, { key: 'progress', label: t('tasks.detail.progress'), value: active.progress }));
          }
          if (typeof active.result === 'string' && active.result !== '') {
            fields.push(h(DetailField, { key: 'result', label: t('tasks.detail.result'), value: active.result }));
          }
          if (active.blocker !== null && active.blocker !== undefined) {
            if (typeof active.blocker.reason === 'string' && active.blocker.reason !== '') {
              fields.push(h(DetailField, { key: 'blocker', label: t('tasks.detail.blocker'), value: active.blocker.reason }));
            }
            if (typeof active.blocker.unblock === 'string' && active.blocker.unblock !== '') {
              fields.push(h(DetailField, { key: 'unblock', label: t('tasks.detail.unblock'), value: active.blocker.unblock }));
            }
          }
          if (typeof active.ownerSessionId === 'string' && active.ownerSessionId !== '') {
            const liveText = active.executorLost === true
              ? t('tasks.detail.ownerLost')
              : (active.ownerLive === true ? t('tasks.detail.ownerLive') : t('tasks.detail.ownerGone'));
            const ownerLabel = typeof active.ownerName === 'string' && active.ownerName !== ''
              ? active.ownerName
              : active.ownerSessionId;
            fields.push(h(DetailField, {
              key: 'owner',
              label: t('tasks.detail.owner'),
              value: `${ownerLabel} · ${liveText}`,
              mono: true,
            }));
          }
          const completionText = taskCompletionText(active.completion, t);
          if (completionText !== '') {
            fields.push(h(DetailField, { key: 'completion', label: t('tasks.detail.completion'), value: completionText }));
          }
          if (typeof active.completionBasis === 'string' && active.completionBasis !== '') {
            fields.push(h(DetailField, { key: 'completionBasis', label: t('tasks.detail.completionBasis'), value: active.completionBasis }));
          }
          if (active.deferred === true) {
            if (typeof active.deferredReason === 'string' && active.deferredReason !== '') {
              fields.push(h(DetailField, { key: 'deferredReason', label: t('tasks.detail.deferredReason'), value: active.deferredReason }));
            }
            if (typeof active.resumeCondition === 'string' && active.resumeCondition !== '') {
              fields.push(h(DetailField, { key: 'resumeCondition', label: t('tasks.detail.resumeCondition'), value: active.resumeCondition }));
            }
          }
          if (typeof active.updatedAt === 'number' && active.updatedAt > 0) {
            fields.push(h('div', { key: 'updated', className: 'sp-detail-meta' }, t('tasks.detail.updated', { time: relTime(active.updatedAt, t) })));
          }
          blocks.push(h('section', { key: 'task', className: 'sp-detail-block' },
            h('div', { className: 'sp-detail-block-title' }, t('tasks.detail.info')),
            fields));
          const archiveHistory = Array.isArray(active.archiveHistory) ? active.archiveHistory : [];
          if (archiveHistory.length > 0) {
            blocks.push(h('section', { key: 'archive-history', className: 'sp-detail-block' },
              h('div', { className: 'sp-detail-block-title' }, t('tasks.detail.archiveHistory')),
              h('div', { className: 'sp-detail-list' },
                archiveHistory.slice().reverse().map((entry, index) => h('div', {
                  key: `${String(entry.at)}-${index}`,
                  className: 'sp-detail-change',
                },
                  h('div', { className: 'sp-detail-change-meta' },
                    `${relTime(entry.at, t)} · ${String(entry.reason ?? '')}`))))));
          }
        } else if (archivedEntry !== undefined) {
          blocks.push(h('section', { key: 'archived-task', className: 'sp-detail-block' },
            h('div', { className: 'sp-detail-block-title' }, t('tasks.detail.archivedTitle')),
            h(DetailField, { label: t('tasks.detail.archiveReason'), value: archivedEntry.archiveReason }),
            typeof archivedEntry.archivedAt === 'number' && archivedEntry.archivedAt > 0
              ? h(DetailField, { label: t('tasks.detail.archivedAt'), value: relTime(archivedEntry.archivedAt, t) })
              : null));
        }

        const archivedCount = typeof data.archivedCount === 'number' ? data.archivedCount : archived.length;
        {
          blocks.push(h('section', { key: 'archived-list', className: 'sp-detail-block' },
            h('button', {
              type: 'button',
              className: 'sp-detail-block-toggle',
              'aria-expanded': archivedOpen,
              onClick: () => setArchivedOpen((value) => !value),
            },
              h(Glyph, { name: archivedOpen ? 'chevron-down' : 'chevron-right', size: 12 }),
              h('span', null, t('tasks.detail.archived', { n: archivedCount }))),
            archivedOpen && archivedCount === 0
              ? h('div', { className: 'sp-empty' }, t('tasks.detail.archivedEmpty'))
              : null,
            archivedOpen && archivedCount > 0
              ? h('div', { className: 'sp-detail-list' },
                archived.map((entry) => h('button', {
                  key: entry.id,
                  type: 'button',
                  className: 'sp-detail-archive-row',
                  title: typeof entry.title === 'string' ? entry.title : '',
                  onClick: () => {
                    if (api !== undefined && typeof api.openTask === 'function') api.openTask(targetSession, entry.id);
                  },
                },
                  h('span', { className: 'sp-detail-archive-title' }, entry.title),
                  typeof entry.archiveReason === 'string' && entry.archiveReason !== ''
                    ? h('span', { className: 'sp-detail-archive-meta' }, entry.archiveReason)
                    : null,
                  typeof entry.archivedAt === 'number' && entry.archivedAt > 0
                    ? h('span', { className: 'sp-detail-archive-meta' }, relTime(entry.archivedAt, t))
                    : null)))
              : null));
        }

        body = h('div', { className: 'sp-detail-body' },
          state.message
            ? h('div', { className: 'sp-error' },
              h('span', null, t('state.error', { message: state.message })),
              h('button', { className: 'sp-link', onClick: state.retry }, t('state.retry')))
            : null,
          blocks);
      }

      const title = active !== undefined
        ? (typeof active.title === 'string' ? active.title : t('tasks.detail.title'))
        : (archivedEntry !== undefined && typeof archivedEntry.title === 'string'
          ? archivedEntry.title
          : t('tasks.detail.title'));
      return h('div', { className: 'sp-detail-root' },
        h(Styles, null),
        h('div', { className: 'sp-detail-toolbar' },
          h(Glyph, { name: 'tasks', size: 14 }),
          h('span', { className: 'sp-detail-title', title }, title),
          active !== undefined
            ? h('span', { className: 'sp-task-status sp-task-status-' + String(active.status ?? 'pending') }, taskStatusText(active.status, t))
            : null,
          h('button', {
            className: 'sp-icon-btn',
            title: t('panel.refresh'),
            'aria-label': t('panel.refresh'),
            onClick: state.retry,
          }, h(Glyph, { name: 'refresh', size: 13 }))),
        body);
    }

    // ------------------------------------------------------------------
    // panel + entry
    // ------------------------------------------------------------------

    const BUILTIN_SECTIONS = [
      { id: 'tasks', order: 5, Component: TasksSection },
      { id: 'git', order: 10, Component: GitSection },
      { id: 'outputs', order: 20, Component: OutputsSection },
      { id: 'subagents', order: 30, Component: SubagentsSection },
      { id: 'sources', order: 40, Component: SourcesSection },
    ];

    // The floating panel keeps the conversation column untouched: it measures
    // the chat flow's right edge and only occupies the empty band beside it.
    function measurePanelSpace() {
      const fallback = { top: 56, right: 12, width: 240, maxHeight: 640 };
      if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
      const width = typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
      const height = typeof window.innerHeight === 'number' ? window.innerHeight : 768;
      let chatRight = 0;
      try {
        // Chat rows sit inside the centered conversation column, so their right
        // edge is the content edge we must not cover. The flow container falls
        // back to the full width in some layouts, so it is only a last resort.
        for (const node of document.querySelectorAll('[data-slot="conversation.chat.node"]')) {
          const rect = node.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) chatRight = Math.max(chatRight, rect.right);
        }
        if (chatRight === 0) {
          for (const node of document.querySelectorAll('[data-slot="conversation.chat.flow"]')) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) chatRight = Math.max(chatRight, rect.right);
          }
        }
      } catch {
        chatRight = 0;
      }
      if (chatRight === 0) {
        // Last resort: derive the centered column width from the layout token.
        try {
          const raw = window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-chat-content-width');
          const match = /([\d.]+)px/.exec(raw);
          if (match !== null) {
            const chatWidth = Math.min(Number(match[1]), width);
            chatRight = Math.max(0, Math.round((width + chatWidth) / 2));
          }
        } catch {
          chatRight = 0;
        }
      }
      const margin = chatRight > 0 ? width - chatRight : width - 28;
      // Compact by design: stay narrow so the floating card borrows the right
      // margin instead of covering the conversation.
      const panelWidth = Math.max(180, Math.min(240, Math.floor(margin - 12)));
      return {
        top: 56,
        right: 12,
        width: panelWidth,
        maxHeight: Math.max(220, height - 72),
      };
    }

    function popoverStyle(rect) {
      const width = 260;
      const margin = 8;
      const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
      const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 768;
      const maxHeight = Math.min(320, viewportHeight - margin * 2);
      let left = margin;
      let top = margin;
      if (rect !== null && rect !== undefined) {
        left = rect.left - width - 10;
        if (left < margin) left = rect.left;
        top = rect.top - 4;
      }
      left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin));
      top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - maxHeight - margin));
      return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, width: `${width}px`, maxHeight: `${maxHeight}px` };
    }

    function TaskDetailPopover({ detail, t, api, sessionId }) {
      const task = detail.task;
      if (task === null || task === undefined) return null;
      const fields = [];
      if (typeof task.summary === 'string' && task.summary !== '') {
        fields.push(h(DetailField, { key: 'summary', label: t('tasks.detail.summary'), value: task.summary }));
      }
      if (typeof task.progress === 'string' && task.progress !== '') {
        fields.push(h(DetailField, { key: 'progress', label: t('tasks.detail.progress'), value: task.progress }));
      }
      // Only the blocker is promoted: it changes what the user should do next.
      // Result, owner, completion and archive history stay in the sidebar tab.
      if (task.blocker !== null && task.blocker !== undefined) {
        fields.push(h(DetailField, {
          key: 'blocker',
          label: t('tasks.detail.blocker'),
          value: task.blocker.reason === '' ? '—' : task.blocker.reason,
        }));
        if (typeof task.blocker.unblock === 'string' && task.blocker.unblock !== '') {
          fields.push(h(DetailField, { key: 'unblock', label: t('tasks.detail.unblock'), value: task.blocker.unblock }));
        }
      }
      if (detail.archived === true && typeof task.archiveReason === 'string' && task.archiveReason !== '') {
        fields.push(h(DetailField, { key: 'archiveReason', label: t('tasks.detail.archiveReason'), value: task.archiveReason }));
      }
      const status = task.status === undefined ? 'pending' : task.status;
      return h('div', {
        className: 'sp-detail-pop',
        style: popoverStyle(detail.rect),
        role: 'dialog',
        'aria-label': typeof task.title === 'string' ? task.title : t('tasks.detail.title'),
      },
        h('div', { className: 'sp-detail-pop-head' },
          h('span', { className: 'sp-detail-pop-title' }, task.title),
          h('span', { className: 'sp-task-status sp-task-status-' + String(status) }, taskStatusText(status, t))),
        fields.length > 0 ? h('div', { className: 'sp-detail-pop-fields' }, fields) : null,
        h('div', { className: 'sp-detail-pop-foot' },
          h('button', {
            className: 'sp-link',
            onClick: () => api.openTask(sessionId, task.id),
          }, t('tasks.detail.openTab'))));
    }

    function Panel({ api, locale, useSessions }) {
      const snapshot = useSnapshot(panelStore);
      const external = useSnapshot(sectionRegistry);
      const t = useT(locale);
      // The frame's session wins when it is available: it also reports the
      // welcome page, where no session exists at all. The stored session stays
      // as the fallback for hosts without that hook.
      const followed = useMainViewSession(useSessions);
      const sessionId = followed.supported === true ? followed.id : snapshot.sessionId;
      const open = snapshot.open === true && sessionId !== null && sessionId !== undefined;
      const [space, setSpace] = React.useState(() => measurePanelSpace());
      const contextState = useSection(sessionId, 'context', snapshot.nonce);
      const subagent = contextState.status === 'ready' && contextState.data !== undefined
        ? contextState.data.subagent ?? null
        : null;
      const isSubagent = subagent !== null;
      const tip = useSnapshot(tipStore);
      const detail = useSnapshot(detailStore);

      React.useEffect(() => {
        if (!open) {
          hideTip();
          api.closeTaskDetail();
        }
      }, [open, api]);

      // Switching sessions invalidates any popover or tooltip opened for the
      // previous one: they carry that session's task, not this one's.
      React.useEffect(() => {
        hideTip();
        api.closeTaskDetail();
      }, [sessionId, api]);

      // Mirror the frame into the store, including "no session": the welcome
      // page must clear the stored id, which the unmounted entry button can no
      // longer do. The panel's open flag is untouched, so the user's expanded or
      // collapsed preference survives until a session comes back.
      React.useEffect(() => {
        if (followed.supported !== true) return;
        api.setActiveSession(followed.id);
      }, [followed.supported, followed.id, api]);

      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setInterval(() => api.refresh(), 20000);
        return () => clearInterval(timer);
      }, [open, api]);

      React.useEffect(() => {
        if (!open) return undefined;
        const update = () => setSpace(measurePanelSpace());
        update();
        const timer = setInterval(update, 300);
        const onResize = () => update();
        const canListen = typeof window.addEventListener === 'function';
        if (canListen) window.addEventListener('resize', onResize);
        return () => {
          clearInterval(timer);
          if (canListen) window.removeEventListener('resize', onResize);
        };
      }, [open]);

      // The panel is persistent: outside clicks no longer dismiss it. Only
      // Escape, the close button, and the entry toggle close the panel.
      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (detail.visible === true) {
            api.closeTaskDetail();
            return;
          }
          api.close();
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [open, api, detail.visible]);

      React.useEffect(() => {
        if (!open || detail.visible !== true) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (target !== null && target !== undefined && typeof target.closest === 'function') {
            if (target.closest('.sp-detail-pop') !== null) return;
            if (target.closest('.sp-task-main') !== null) return;
            if (target.closest('.sp-task-arrow') !== null) return;
          }
          api.closeTaskDetail();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open, detail.visible, api]);

      if (!open) return null;

      const sections = BUILTIN_SECTIONS.map((section) => {
        const Component = section.Component;
        return h(Component, { key: section.id, sessionId, nonce: snapshot.nonce, t, api, isSubagent });
      });
      for (const definition of external) {
        sections.push(h(ExternalSection, {
          key: definition.id,
          definition,
          sessionId,
          nonce: snapshot.nonce,
          t,
          locale,
          api,
        }));
      }

      const style = {
        top: `${space.top}px`,
        right: `${space.right}px`,
        width: `${space.width}px`,
        maxHeight: `${space.maxHeight}px`,
      };
      const banner = isSubagent
        ? h('div', { className: 'sp-context' },
          h(Glyph, { name: 'robot', size: 14 }),
          h('div', { className: 'sp-context-main' },
            h('span', { className: 'sp-context-label', title: subagent.childSessionId }, subagent.label || t('context.unknown')),
            h('span', { className: 'sp-context-meta' }, t('context.subagent'))),
          subagent.parentSessionId !== null && subagent.parentSessionId !== undefined
            ? h('button', {
              className: 'sp-link',
              onClick: () => api.openParent(subagent.parentSessionId),
            }, t('context.back'))
            : null)
        : null;
      return h('div', { className: 'sp-root', style },
        h(Styles, null),
        h('div', { className: 'sp-panel', role: 'dialog', 'aria-label': t('panel.title') },
          h('header', { className: 'sp-head' },
            h('span', { className: 'sp-head-glyph' }, h(Glyph, { name: 'panel', size: 16 })),
            h('span', { className: 'sp-head-title' }, t('panel.title')),
            h('button', {
              className: 'sp-icon-btn',
              title: t('panel.refresh'),
              'aria-label': t('panel.refresh'),
              onClick: () => api.refresh(),
            }, h(Glyph, { name: 'refresh', size: 14 })),
            h('button', {
              className: 'sp-icon-btn',
              title: t('panel.close'),
              'aria-label': t('panel.close'),
              onClick: () => api.close(),
            }, h(Glyph, { name: 'close', size: 14 }))),
          h('div', { className: 'sp-body', onScroll: () => api.closeTaskDetail() }, banner, sections)),
        detail.visible === true && detail.task !== null
          ? h(TaskDetailPopover, { detail, t, api, sessionId })
          : null,
        tip.visible === true
          ? h('div', { className: 'sp-task-tip', style: tooltipStyle(tip.rect), role: 'tooltip' },
            h('div', { className: 'sp-tip-title' }, tip.title),
            tip.text !== '' ? h('div', { className: 'sp-tip-text' }, tip.text) : null,
            tip.note !== '' ? h('div', { className: 'sp-tip-text sp-tip-blocker' }, tip.note) : null)
          : null);
    }

    function EntryButton({ sessionId, api, locale }) {
      const t = useT(locale);
      const snapshot = useSnapshot(panelStore);
      const [tip, setTip] = React.useState(null);
      const identity = sessionId === null || sessionId === undefined ? '' : String(sessionId);
      // Entry status lamp: small payload, polled every 5s regardless of the
      // panel being open, so the dot is current when the panel is closed.
      const statusState = usePolledData({
        path: 'summary-panel/tasks/status',
        sessionId,
        interval: 5000,
        nonce: snapshot.nonce,
        identity,
      });
      const statusReady = statusState.status === 'ready' && statusState.identity === identity;
      const focus = statusReady && Array.isArray(statusState.data?.focus) ? statusState.data.focus : [];
      const firstFocus = focus.length > 0 ? focus[0] : null;
      React.useEffect(() => {
        const next = sessionId === null || sessionId === undefined || sessionId === '' ? null : sessionId;
        api.setActiveSession(next);
        // Unmounting (the welcome page has no session header at all) is the one
        // moment this component cannot report an empty id through props.
        return () => { api.clearSession(next); };
      }, [sessionId, api]);
      const openForThisSession = snapshot.open === true && snapshot.sessionId === sessionId;
      const entryTitle = firstFocus !== null && typeof firstFocus.title === 'string' && firstFocus.title !== ''
        ? t('entry.focusTitle', { label: t('entry.label'), title: firstFocus.title })
        : t('entry.label');
      const focusBlocked = firstFocus !== null
        && (firstFocus.blocked === true || firstFocus.status === 'blocked');
      const dot = firstFocus === null
        ? null
        : h('span', {
          className: 'sp-entry-dot' + (focusBlocked ? ' sp-entry-dot-warn' : ''),
          'aria-hidden': true,
        });
      return h(React.Fragment, null,
        h(Styles, null),
        h('button', {
          className: 'sp-entry' + (openForThisSession ? ' sp-entry-active' : ''),
          title: entryTitle,
          'aria-label': t('entry.label'),
          'aria-expanded': openForThisSession,
          onMouseEnter: (event) => {
            let rect = null;
            try {
              rect = event.currentTarget.getBoundingClientRect();
            } catch {
              rect = null;
            }
            setTip({ rect });
          },
          onMouseLeave: () => setTip(null),
          onClick: () => api.toggle(sessionId),
        }, h(Glyph, { name: 'panel', size: 16 }), dot),
        tip === null
          ? null
          : h('div', {
            className: 'sp-task-tip',
            style: tooltipStyle(tip.rect, { center: true }),
            role: 'tooltip',
          }, h('div', { className: 'sp-tip-title' }, entryTitle)));
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    return {
      name: 'summary-panel',
      inject: ['slots', 'locale'],
      apply(ctx) {
        let sidebarRight;
        let uiWorkspace = ctx.get('uiWorkspace');
        if (uiWorkspace === undefined) {
          ctx.inject(['uiWorkspace'], (workspaceScope) => {
            workspaceScope.effect(() => {
              uiWorkspace = workspaceScope.uiWorkspace;
              return () => {
                uiWorkspace = undefined;
              };
            });
          });
        }

        const api = {
          open(sessionId) {
            if (sessionId === null || sessionId === undefined) return;
            const current = panelStore.get();
            panelStore.set({
              sessionId,
              open: true,
              nonce: current.open === true && current.sessionId === sessionId ? current.nonce : current.nonce + 1,
            });
          },
          close() {
            panelStore.set({ open: false });
          },
          toggle(sessionId) {
            const current = panelStore.get();
            if (current.open === true && current.sessionId === sessionId) {
              panelStore.set({ open: false });
              return;
            }
            this.open(sessionId);
          },
          refresh() {
            panelStore.set({ nonce: panelStore.get().nonce + 1 });
          },
          // A new session (or a welcome page) may report no id at all. Clearing
          // the stored id keeps the panel from showing the previous session's
          // data; `open` stays untouched so the user's expanded/collapsed
          // preference survives until a real session arrives.
          setActiveSession(sessionId) {
            const next = sessionId === null || sessionId === undefined || sessionId === '' ? null : String(sessionId);
            const current = panelStore.get();
            if (current.sessionId !== next) {
              panelStore.set({ sessionId: next, nonce: current.nonce + 1 });
            }
          },
          // The session header can disappear (welcome page) without ever
          // reporting an empty id. Clearing only the session this caller was
          // showing keeps a newer one from being wiped by a late unmount.
          clearSession(expected) {
            const current = panelStore.get();
            if (current.sessionId === null || current.sessionId === undefined) return;
            if (expected !== undefined && expected !== null && current.sessionId !== expected) return;
            panelStore.set({ sessionId: null, nonce: current.nonce + 1 });
          },
          openSourceFile(address) {
            if (sidebarRight === undefined || typeof address !== 'string' || address === '') return;
            try {
              sidebarRight.openResource(address);
              panelStore.set({ open: false });
            } catch (error) {
              console.error('[summary-panel] failed to open the file preview', error);
            }
          },
          openSourceUrl(url) {
            if (typeof url !== 'string' || url === '') return;
            if (sidebarRight !== undefined) {
              try {
                sidebarRight.openTab('browser', { params: { url } });
                panelStore.set({ open: false });
                return;
              } catch (error) {
                console.error('[summary-panel] failed to open the browser tab', error);
              }
            }
            try {
              window.open(url, '_blank', 'noopener');
            } catch {
              /* ignore popup failures */
            }
          },
          openParent(sessionId) {
            if (uiWorkspace === undefined || typeof sessionId !== 'string' || sessionId === '') return;
            try {
              uiWorkspace.openSession(sessionId);
              panelStore.set({ open: false });
            } catch (error) {
              console.error('[summary-panel] failed to open the parent session', error);
            }
          },
          openSubagent(parentSessionId, child) {
            if (uiWorkspace === undefined || child === null || child === undefined) return;
            try {
              uiWorkspace.openSession({
                parentSessionId,
                childSessionId: child.id,
                mode: child.mode,
              });
              panelStore.set({ open: false });
            } catch (error) {
              console.error('[summary-panel] failed to open the subagent session', error);
            }
          },
          openDiff(sessionId, path) {
            if (sidebarRight === undefined) return;
            try {
              sidebarRight.openTab('summary-panel.diff', { params: { sessionId, path } });
              panelStore.set({ open: false });
            } catch (error) {
              console.error('[summary-panel] failed to open the diff tab', error);
            }
          },
          showTaskDetail({ task, archived = false, rect = null }) {
            if (task === null || task === undefined || typeof task.id !== 'string') return;
            detailStore.set({ visible: true, task, archived: archived === true, rect });
          },
          closeTaskDetail() {
            if (detailStore.get().visible === true) {
              detailStore.set({ visible: false, task: null, archived: false, rect: null });
            }
          },
          openTask(sessionId, taskId) {
            if (sidebarRight === undefined) return;
            if (typeof taskId !== 'string' || taskId === '') return;
            try {
              // The panel is a transient peek; collapse it before the detail
              // tab opens, but keep the anchor/session for reopening.
              sidebarRight.openTab('summary-panel.task', { params: { sessionId, taskId } });
              panelStore.set({ open: false });
            } catch (error) {
              console.error('[summary-panel] failed to open the task tab', error);
            }
          },
          sections: sectionRegistry,
        };

        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH));
        ctx.effect(() => ctx.locale.register(NS, 'en', EN));
        ctx.effect(() => ctx.provide('summaryPanel', api));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'summary-panel.panel',
          order: 100,
        }, (props) => h(Panel, Object.assign({}, props, { api, locale: ctx.locale }))));

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'summary-panel.entry',
          order: -4,
        }, (props) => h(EntryButton, Object.assign({}, props, { api, locale: ctx.locale }))));

        // Optional integration: the live-diff tab lives in the right sidebar.
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          scope.effect(() => {
            sidebarRight = scope.sidebarRight;
            return () => {
              sidebarRight = undefined;
            };
          });
          scope.effect(() => scope.sidebarRightTabs.register({
            id: 'summary-panel.diff',
            kind: 'summary-panel.diff',
            title: () => {
              try {
                return scope.locale.getLocale().active === 'en' ? 'Changes' : '变更';
              } catch {
                return 'Changes';
              }
            },
          }), 'summary-panel: diff tab type');
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'summary-panel.diff',
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          }, DiffBody)), 'summary-panel: diff tab body');
          scope.effect(() => scope.sidebarRightTabs.register({
            id: 'summary-panel.task',
            kind: 'summary-panel.task',
            title: () => {
              try {
                return makeT(scope.locale)('tasks.tabTitle');
              } catch {
                return 'Task';
              }
            },
          }), 'summary-panel: task tab type');
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: 'summary-panel.task',
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          }, (props) => h(TaskDetailBody, Object.assign({}, props, { api })))), 'summary-panel: task tab body');
        });
      },
    };
  },
});
