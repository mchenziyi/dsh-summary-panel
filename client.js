/**
 * Client half of the summary panel bundle.
 *
 * Registers two seats:
 *  - `conversation.session.header.utilities`: the top-right entry button,
 *    beside the shipped utilities (Codex-style entry).
 *  - `shell.overlay`: the floating panel itself, anchored to the right edge.
 *
 * Built-in sections are the summary panel's own (Git, outputs, subagents,
 * sources). Other plugins may register further sections through the client
 * service `ctx.summaryPanel`.
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
      'panel.title': '摘要',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
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
      'panel.title': 'Summary',
      'panel.refresh': 'Refresh',
      'panel.close': 'Close',
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
.sp-entry{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;padding:0}
.sp-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-entry.sp-entry-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.sp-root{position:fixed;top:62px;right:14px;bottom:auto;max-height:calc(100vh - 76px);width:min(420px,calc(100vw - 28px));display:flex;pointer-events:auto;z-index:40}
.sp-panel{display:flex;flex-direction:column;flex:1;min-height:0;max-height:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-panel);overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px}
.sp-head{display:flex;align-items:center;gap:6px;padding:11px 10px 10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.sp-head-glyph{color:var(--dsw-alias-brand-primary);display:inline-flex}
.sp-head-title{flex:1;font-size:13px;font-weight:600;letter-spacing:.01em}
.sp-icon-btn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;cursor:pointer;padding:0}
.sp-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sp-body{overflow-y:auto;overscroll-behavior:contain;padding:6px 8px 12px;display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0}
.sp-card{border-radius:10px;padding:2px 0}
.sp-card+.sp-card{border-top:1px solid var(--dsw-alias-border-l1)}
.sp-card-head{width:100%;display:flex;align-items:center;gap:7px;padding:8px 6px;background:transparent;border:0;color:inherit;cursor:pointer;border-radius:8px;text-align:left;font:inherit}
.sp-card-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sp-card-head>svg{color:var(--dsw-alias-label-secondary);flex:none}
.sp-card-title{flex:1;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.sp-card-badge{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);padding:1px 7px;border-radius:999px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-card-body{padding:0 6px 8px;display:flex;flex-direction:column;gap:6px}
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
.sp-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 2px}
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

    const panelStore = createStore({ sessionId: null, open: false, nonce: 0, anchor: null });

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

    function anchorOfElement(element) {
      if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') return null;
      try {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.max(8, Math.round(rect.bottom + 8)),
          right: Math.max(8, Math.round(window.innerWidth - rect.right)),
        };
      } catch {
        return null;
      }
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

      React.useEffect(() => {
        if (sessionId === null || sessionId === undefined) {
          setState({ status: 'idle' });
          return undefined;
        }
        let cancelled = false;
        const controller = new AbortController();
        setState((previous) => (previous.status === 'ready'
          ? Object.assign({}, previous, { refreshing: true })
          : { status: 'loading' }));
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
            if (!cancelled) setState({ status: 'ready', data, at: Date.now() });
          })
          .catch((error) => {
            if (cancelled) return;
            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
            const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
              ? error.message
              : String(error);
            setState((previous) => (previous.status === 'ready'
              ? Object.assign({}, previous, { refreshing: false, message })
              : { status: 'error', message }));
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
    // panel + entry
    // ------------------------------------------------------------------

    const BUILTIN_SECTIONS = [
      { id: 'git', order: 10, Component: GitSection },
      { id: 'outputs', order: 20, Component: OutputsSection },
      { id: 'subagents', order: 30, Component: SubagentsSection },
      { id: 'sources', order: 40, Component: SourcesSection },
    ];

    function Panel({ api, locale }) {
      const snapshot = useSnapshot(panelStore);
      const external = useSnapshot(sectionRegistry);
      const t = useT(locale);
      const sessionId = snapshot.sessionId;
      const open = snapshot.open === true && sessionId !== null && sessionId !== undefined;
      const contextState = useSection(sessionId, 'context', snapshot.nonce);
      const subagent = contextState.status === 'ready' && contextState.data !== undefined
        ? contextState.data.subagent ?? null
        : null;
      const isSubagent = subagent !== null;
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setInterval(() => api.refresh(), 20000);
        return () => clearInterval(timer);
      }, [open, api]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            api.close();
          }
        };
        const onPointerDown = (event) => {
          const element = panelRef.current;
          if (element === null) return;
          if (element.contains(event.target)) return;
          if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('.sp-entry') !== null) return;
          api.close();
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open, api]);

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

      const anchor = snapshot.anchor;
      const rootStyle = anchor === null || anchor === undefined
        ? undefined
        : { top: `${anchor.top}px`, right: `${anchor.right}px`, maxHeight: `calc(100vh - ${anchor.top}px - 14px)` };
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
      return h('div', { className: 'sp-root', style: rootStyle },
        h(Styles, null),
        h('div', { className: 'sp-panel', ref: panelRef, role: 'dialog', 'aria-label': t('panel.title') },
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
          h('div', { className: 'sp-body' }, banner, sections)));
    }

    function EntryButton({ sessionId, api, locale }) {
      const t = useT(locale);
      const snapshot = useSnapshot(panelStore);
      const buttonRef = React.useRef(null);
      React.useEffect(() => {
        if (sessionId !== null && sessionId !== undefined) api.setActiveSession(sessionId);
      }, [sessionId, api]);
      const openForThisSession = snapshot.open === true && snapshot.sessionId === sessionId;
      React.useEffect(() => {
        if (!openForThisSession) return undefined;
        const measure = () => api.setAnchor(anchorOfElement(buttonRef.current));
        measure();
        const timer = setInterval(measure, 300);
        return () => clearInterval(timer);
      }, [openForThisSession, api]);
      return h(React.Fragment, null,
        h(Styles, null),
        h('button', {
          ref: buttonRef,
          className: 'sp-entry' + (openForThisSession ? ' sp-entry-active' : ''),
          title: t('entry.label'),
          'aria-label': t('entry.label'),
          'aria-expanded': openForThisSession,
          onClick: () => api.toggle(sessionId, buttonRef.current),
        }, h(Glyph, { name: 'panel', size: 16 })));
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
          open(sessionId, element) {
            if (sessionId === null || sessionId === undefined) return;
            const current = panelStore.get();
            panelStore.set({
              sessionId,
              open: true,
              anchor: anchorOfElement(element),
              nonce: current.open && current.sessionId === sessionId ? current.nonce : current.nonce + 1,
            });
          },
          close() {
            panelStore.set({ open: false });
          },
          toggle(sessionId, element) {
            const current = panelStore.get();
            if (current.open === true && current.sessionId === sessionId) {
              panelStore.set({ open: false });
              return;
            }
            this.open(sessionId, element);
          },
          refresh() {
            panelStore.set({ nonce: panelStore.get().nonce + 1 });
          },
          setAnchor(anchor) {
            if (anchor === null || anchor === undefined) return;
            const current = panelStore.get().anchor;
            if (current !== null && current !== undefined && current.top === anchor.top && current.right === anchor.right) return;
            panelStore.set({ anchor });
          },
          setActiveSession(sessionId) {
            if (sessionId === null || sessionId === undefined) return;
            const current = panelStore.get();
            if (current.sessionId !== sessionId) {
              panelStore.set({ sessionId, open: false });
            }
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
        });
      },
    };
  },
});
