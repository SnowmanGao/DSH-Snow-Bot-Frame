// =====================================================================
//  index.ts —— 插件入口
//
//  此处仅编排执行顺序，具体后台实现见 runtime.ts
// =====================================================================

import { registerConfigRoutes } from './bridge/config_routes.js';
import { TulpaMcp } from './bridge/tulpa_mcp.js';
import { dbg } from './common/debug_log.js';
import type { Ctx } from './common/dsh_types.js';
import { resolveConfig, type TulpaLiteConfig } from './config_schema.js';
import { GroupResolver } from './group_resolver.js';
import { registerEvents, type Runtime } from './runtime.js';
import { applyPatches } from './tools_of_chat.js';

// 本函数由宿主 DSH 调用
function apply(ctx: Ctx, config: TulpaLiteConfig) {
  dbg('[snow-bot] apply() 入口');

  const cfg = resolveConfig(config);
  const mcp = new TulpaMcp({ bearer: cfg.bearer, url: cfg.endpoint });
  const resolver = new GroupResolver(mcp, ctx.logger);
  const rt: Runtime = {
    deps: { ctx, cfg, mcp, resolver },
    workspaceTitle: cfg.ws.split(/[\\/]/).filter(Boolean).pop() ?? 'QQAgent',
    attached: new Set(), hooked: new Set(),
  };
  dbg('[snow-bot] 配置就绪 ws=', cfg.ws, 'endpoint=', cfg.endpoint ?? '(默认)');

  // 配置面板展示用的扁平结构
  registerConfigRoutes(ctx, () => ({
    workspace: cfg.ws,
    tulpaUrl: cfg.endpoint ?? '',
    tulpaBearer: cfg.bearer,
    toolAllowlist: cfg.toolAllowlist,
    patchEnabled: cfg.patchEnabled,
    learned: resolver.listLearned()
  }));

  // 应用暴力补丁，最容易随版本更新失效！
  applyPatches(cfg.patchEnabled);

  // 注册运行时事件监听，同时查漏补缺
  registerEvents(rt);

  dbg('[snow-bot] apply() 完成');
}

export { Config } from './config_schema.js';
export { apply };
