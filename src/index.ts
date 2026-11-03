// =====================================================================
//  index.ts —— 插件入口：resolveConfig 编排 + apply
//
//  少量编排：解包配置 → 组装 TulpaMcp / GroupResolver / HookDeps /
//  Runtime → 注册配置路由 → 注入 patch → 监听 session/event。
//  事件执行逻辑与 agent 挂钩见 runtime.ts。
// =====================================================================

import { resolveConfig, type ResolvedConfig, type TulpaLiteConfig } from './config_schema.js';
import { registerConfigRoutes } from './bridge/config_routes.js';
import { applyPatches } from './tools_of_chat.js';
import { TulpaMcp } from './bridge/tulpa_mcp.js';
import { GroupResolver } from './group_resolver.js';
import { onSessionEvent, type HookDeps, type Runtime } from './runtime.js';
import type { Ctx } from './common/dsh_types.js';

// 配置面板展示用的扁平形状（已解包 + 学习到的群映射）。
const toConfigForm = (cfg: ResolvedConfig, learned: unknown) => ({
  workspace: cfg.ws,
  tulpaUrl: cfg.endpoint ?? '',
  tulpaBearer: cfg.bearer,
  toolAllowlist: cfg.toolAllowlist,
  patchEnabled: cfg.patchEnabled,
  learned,
});

function apply(ctx: Ctx, config: TulpaLiteConfig) {
  const cfg = resolveConfig(config);
  // 唯一的 Tulpa 连接入口：bearer/url 在此收敛，下游一律收 TulpaMcp 实例。
  const mcp = new TulpaMcp({ bearer: cfg.bearer, url: cfg.endpoint });
  const resolver = new GroupResolver(mcp);
  const deps: HookDeps = { ctx, cfg, mcp, resolver };
  const rt: Runtime = {
    deps,
    workspaceTitle: cfg.ws.split(/[\\/]/).filter(Boolean).pop() ?? 'QQAgent',
    attached: new Set(),
    hooked: new Set(),
  };

  registerConfigRoutes(ctx, () => toConfigForm(cfg, resolver.listLearned()));
  applyPatches(cfg.patchEnabled);
  ctx.on('session/event', (session, event) => onSessionEvent(rt, session, event));
}

export { apply };
export { Config } from './config_schema.js';
