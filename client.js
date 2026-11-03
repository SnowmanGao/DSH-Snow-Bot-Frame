// client.js —— dsh-snow-bot-frame 客户端半（desktop 端）。
//
// 文案统一走官方 locale 服务（@deepseek-ai/dsh-client-locale）：apply 里
// ctx.locale.register('snow-bot', { zh, en }) 注册字典，ctx.locale.bind 得到 t，
// 组件用 t(key) 取文案。字典内联在本文件——client bundle 的 require 只按包名
// 解析宿主模块，无法 import 同包 TS 文件，官方 client 插件的字典同样是打包内联的。
//
// 配置读写仍走 host 侧 /snow-bot/config 路由（desktop 端没有 configForms）。
window.__ModuleLoader__.load({
  id: 'dsh-snow-bot-frame',
  factory(nodeRequire) {
    const React = nodeRequire('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    // host 侧注册的配置读写路由（相对路径，desktop 由 IPC 桥转发）。
    const CONFIG_PATH = '/snow-bot/config';
    // locale 命名空间与主面板 id。
    const NS = 'snow-bot';
    const PANEL_ID = 'snow-bot';

    // 表单样式：跟随宿主主题（--dsw-alias-* 是 DSH 的主题变量，缺失时给浅色兜底）。
    const CSS = `
      .sb-field { margin-bottom: 16px; }
      .sb-label { display: block; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, #1a1a1a); margin-bottom: 6px; font-weight: 500; }
      .sb-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #888); margin-top: 5px; }
      .sb-input, .sb-textarea {
        width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px; line-height: 1.5;
        color: var(--dsw-alias-label-primary, #1a1a1a);
        background: var(--dsw-alias-bg-layer-2, #fff);
        border: 1px solid var(--dsw-alias-border-l3, #d4d4d4); border-radius: 6px;
      }
      .sb-input:focus, .sb-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4f6ef7); }
      .sb-textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize: vertical; }
      .sb-pre { margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-secondary, #555); background: var(--dsw-alias-bg-layer-2, #fafafa); border: 1px solid var(--dsw-alias-border-l3, #e4e4e4); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
      .sb-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary, #1a1a1a); cursor: pointer; border: 1px solid var(--dsw-alias-border-l3, #d4d4d4); background: #ffeb9a }
      .sb-foot { margin-top: 20px; display: flex; align-items: center; gap: 12px; }
      .sb-save { padding: 8px 18px; font-size: 13px; cursor: pointer; border: 0; border-radius: 6px; background: var(--dsw-alias-brand-primary, #4f6ef7); color: #fff; }
      .sb-save:disabled { opacity: 0.5; cursor: not-allowed; }
      .sb-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
      .sb-note--err { color: var(--dsw-alias-state-error-primary, #d3382b); }
      .sb-main { height: 100%; overflow: auto; }
      .sb-main-inner { max-width: 960px; padding: 32px 24px; margin: 0 auto; }
      .sb-title { font-size: 20px; font-weight: 400; line-height: 1.4; color: var(--dsw-alias-label-primary, #1a1a1a); margin-bottom: 20px; }
    `;

    function installStyles() {
      const id = 'dsh-snow-bot-frame-styles';
      if (document.getElementById(id)) return;
      const el = document.createElement('style');
      el.id = id;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function Field(props) {
      return h('div', { className: 'sb-field' },
        h('label', { className: 'sb-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'sb-hint' }, props.hint) : null,
      );
    }

    // 从 host 返回的 config 派生表单草稿（纯 JSON 形状）。
    function fromValue(value) {
      value = value || {};
      return {
        workspace: value.workspace ?? '',
        tulpaUrl: value.tulpaUrl ?? '',
        tulpaBearer: value.tulpaBearer ?? '',
        learned: value.learned ?? [],
        toolAllowlist: (value.toolAllowlist ?? []).join('\n'),
        patchEnabled: !!value.patchEnabled,
      };
    }

    async function loadConfig() {
      const res = await fetch(CONFIG_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'load failed');
      return data.config || {};
    }

    async function saveConfig(config) {
      const res = await fetch(CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return true;
    }

    // 官方 locale 字典：zh 为 key 集。
    const zh = {
      'title': '雪人框架',
      'sidebar.label': '雪人框架',
      'workspace.label': '工作空间文件夹路径',
      'workspace.hint': '群记忆文件与各群工作目录的根目录（<workspace>/groups/<群号>）。',
      'tulpaUrl.label': 'Tulpa MCP 地址',
      'tulpaUrl.hint': '本机 Tulpa 的 streamable-http 端点，默认 http://127.0.0.1:18777/mcp。',
      'tulpaBearer.label': 'Tulpa Bearer 凭据',
      'tulpaBearer.hint': 'Tulpa MCP 的 bearer token（在 Tulpa 里重新授权后粘贴到这里）。',
      'learned.label': '已自动配对的群（openid → 群，只读）',
      'learned.empty': '尚无。发一条群消息即可自动学习配对。',
      'toolAllowlist.label': '工具白名单',
      'toolAllowlist.hint': '每行一个工具名，只保留这些工具；本插件注入的 qqtool 历史工具始终保留。qqbot_send_message（发文本）与 qqbot_send_file（发文件）需在此列出，AI 才能发言。',
      'patchEnabled.label': '源码补丁（必须保持打开状态！）',
      'patchEnabled.hint': '开启后抑制 QQ Bot 插件自动发送功能，便于由 AI 控制发送消息的时机。切换后需重启 DSH 生效。',
      'patchEnabled.option': '注入补丁',
      'save': '保存',
      'saving': '保存中…',
      'loading': '加载中…',
      'loadFailed': '加载配置失败：',
      'saveFailed': '保存失败：',
      'saved': '配置已保存，重启 DSH 生效',
    };

    // 侧边栏入口图标（雪花）。宿主传入 size：展开 18、收起 16；currentColor 跟随侧栏配色与选中态。
    function SnowflakeIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('line', { x1: 12, y1: 2, x2: 12, y2: 22 }),
        h('line', { x1: 20.3, y1: 6.8, x2: 3.7, y2: 17.2 }),
        h('line', { x1: 3.7, y1: 6.8, x2: 20.3, y2: 17.2 }),
        h('path', { d: 'M12 2l2.2 2.2M12 2l-2.2 2.2M12 22l2.2-2.2M12 22l-2.2-2.2' }),
        h('path', { d: 'M20.3 6.8l-1.6 1.8M20.3 6.8l1.2-2.2M3.7 17.2l1.6-1.8M3.7 17.2l-1.2 2.2' }),
        h('path', { d: 'M3.7 6.8l1.6 1.8M3.7 6.8l-1.2-2.2M20.3 17.2l-1.6-1.8M20.3 17.2l1.2 2.2' }),
      );
    }

    function apply(ctx) {
      installStyles();
      // 注册 locale 字典，绑定翻译函数（t 每次调用读取当前 locale 快照，支持语言切换）。
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh }), 'snow-bot: dictionaries');
      } else {
        ctx.locale.register(NS, { zh });
      }
      const t = ctx.locale.bind(NS);

      // 配置表单：文案全部经 t 取，不硬编码。
      function SettingsPanel() {
        const [draft, setDraft] = useState(null);
        const [loadError, setLoadError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [note, setNote] = useState(null);

        useEffect(() => {
          let alive = true;
          loadConfig()
            .then((config) => { if (alive) setDraft(fromValue(config)); })
            .catch((e) => { if (alive) setLoadError(e.message); });
          return () => { alive = false; };
        }, []);

        if (draft === null) {
          if (loadError !== null) {
            return h('div', { className: 'sb-frame' },
              h('div', { className: 'sb-note sb-note--err' }, t('loadFailed') + loadError));
          }
          return h('div', { className: 'sb-frame' },
            h('div', { className: 'sb-note' }, t('loading')));
        }

        const set = (k, v) => setDraft({ ...draft, [k]: v });

        const save = async () => {
          const toolAllowlist = draft.toolAllowlist.split('\n').map((s) => s.trim()).filter(Boolean);
          setBusy(true);
          setNote(null);
          try {
            await saveConfig({
              workspace: draft.workspace,
              tulpaUrl: draft.tulpaUrl,
              tulpaBearer: draft.tulpaBearer,
              toolAllowlist,
              patchEnabled: draft.patchEnabled,
            });
            setNote({ ok: true, text: t('saved') });
          } catch (e) {
            setNote({ ok: false, text: t('saveFailed') + e.message });
          } finally {
            setBusy(false);
          }
        };

        const learnedText = draft.learned.length
          ? draft.learned.map((d) => `${d.groupName}（群号 ${d.groupId}）`).join('\n')
          : t('learned.empty');

        return h('div', { className: 'sb-frame' },
          h(Field, { label: t('workspace.label'), hint: t('workspace.hint') },
            h('input', { className: 'sb-input', value: draft.workspace, onChange: (e) => set('workspace', e.target.value) })),
          h(Field, { label: t('tulpaUrl.label'), hint: t('tulpaUrl.hint') },
            h('input', { className: 'sb-input', value: draft.tulpaUrl, onChange: (e) => set('tulpaUrl', e.target.value) })),
          h(Field, { label: t('tulpaBearer.label'), hint: t('tulpaBearer.hint') },
            h('input', { className: 'sb-input', type: 'password', value: draft.tulpaBearer, onChange: (e) => set('tulpaBearer', e.target.value) })),
          h(Field, { label: t('learned.label') },
            h('pre', { className: 'sb-pre' }, learnedText)),
          h(Field, { label: t('toolAllowlist.label'), hint: t('toolAllowlist.hint') },
            h('textarea', { className: 'sb-textarea', rows: 5, value: draft.toolAllowlist, onChange: (e) => set('toolAllowlist', e.target.value) })),
          h(Field, { label: t('patchEnabled.label'), hint: t('patchEnabled.hint') },
            h('label', { className: 'sb-check' },
              h('input', { type: 'checkbox', checked: draft.patchEnabled, onChange: (e) => set('patchEnabled', e.target.checked) }),
              t('patchEnabled.option'))),
          h('div', { className: 'sb-foot' },
            h('button', { className: 'sb-save', type: 'button', disabled: busy, onClick: save }, busy ? t('saving') : t('save')),
            note ? h('span', { className: 'sb-note' + (note.ok ? '' : ' sb-note--err') }, note.text) : null,
          ),
        );
      }

      // 侧边栏入口点击后展示的主面板：复用同一份配置表单，包一层滚动容器。
      function MainPanel() {
        return h('div', { className: 'sb-main' },
          h('div', { className: 'sb-main-inner' },
            h('div', { className: 'sb-title' }, t('title')),
            h(SettingsPanel)));
      }

      // 主侧边栏入口：参考官方 dsh-qqbot，经 layout 服务注册 sidebar.panellist（入口）+ main（面板）。
      const ctxInject = ctx.inject;
      if (typeof ctxInject === 'function') {
        ctxInject.call(ctx, ['layout'], (pageCtx) => {
          const pageSlots = pageCtx && pageCtx.slots;
          const layout = pageCtx && pageCtx.layout;
          if (pageSlots === undefined || layout === undefined) return undefined;
          const stopMain = pageSlots.inject('main', () => pageSlots.register({
            name: 'main',
            key: PANEL_ID,
          }, MainPanel));
          const stopSidebar = pageSlots.inject('sidebar.panellist', () => pageSlots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: t('sidebar.label'),
          }, SnowflakeIcon));
          return () => { stopSidebar(); stopMain(); };
        });
      }
    }

    return { inject: ['locale', 'slots'], apply };
  },
});
