// =====================================================================
//  index.ts —— 插件入口
//
//  事件执行逻辑与 agent hook 见 runtime.ts。
// =====================================================================

import { resolveConfig, type TulpaLiteConfig } from './config_schema.js';
import { registerConfigRoutes } from './bridge/config_routes.js';
import { applyPatches } from './tools_of_chat.js';
import { TulpaMcp } from './bridge/tulpa_mcp.js';
import { GroupResolver } from './group_resolver.js';
import { onSessionEvent, type Runtime } from './runtime.js';
import type { Ctx } from './common/dsh_types.js';

// 本函数由宿主 DSH 调用
function apply(ctx: Ctx, config: TulpaLiteConfig) {

  const cfg = resolveConfig(config);
  const mcp = new TulpaMcp({ bearer: cfg.bearer, url: cfg.endpoint });
  const resolver = new GroupResolver(mcp);
  const rt: Runtime = {
    deps: { ctx, cfg, mcp, resolver },
    workspaceTitle: cfg.ws.split(/[\\/]/).filter(Boolean).pop() ?? 'QQAgent',
    attached: new Set(), hooked: new Set(),
  };

  // 配置面板展示用的扁平结构
  registerConfigRoutes(ctx, () => ({
    workspace: cfg.ws,
    tulpaUrl: cfg.endpoint ?? '',
    tulpaBearer: cfg.bearer,
    toolAllowlist: cfg.toolAllowlist,
    patchEnabled: cfg.patchEnabled,
    learned: resolver.listLearned()
  }));

  // 应用暴力 Patch 补丁
  applyPatches(cfg.patchEnabled);

  // 挂载时间监听器
  ctx.on('session/event', (session, event) => onSessionEvent(rt, session, event));
}

export { apply };
export { Config } from './config_schema.js';
