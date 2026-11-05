// =====================================================================
//  config_schema.ts —— 插件配置声明（schemastery Schema + 类型）
//
//  与宿主 client 的配置读写通道（HTTP 路由 + cordis.patch.yml 写回）
//  见 bridge/config_routes.ts。
//
//  ResolvedConfig：apply() 里把 Ref 解包后的普通值，供编排与下游使用；
//  resolveConfig 负责解包 + 必填校验（收窄为 string）。
// =====================================================================

import Schema from '@deepseek-ai/schemastery';
import type { Ref } from './common/dsh_types.js';
import { DEFAULT_TOOLS_ALLOWLIST } from './prompt.js';

// Tulpa MCP 默认端点（保持单一数据源）
const TULPA_DEFAULT_URL = 'http://127.0.0.1:18777/mcp';

// 供 GUI 渲染的配置 Schema
const Config = Schema.object({
  /*
    关键：每个叶子字段都要标 .volatile()，DSH 的 SettingsForms 才会把本插件
    纳入「可配置条目」清单（schema 返回 undefined 的条目会被 直接跳过，GUI 
    里不出现）。数组字段整体 volatile、元素字段不标，避免嵌套导致校验报错。
    宿主运行时通过可变引用传递这些字段，插件应使用 .get() 读取当前快照。
  */
  workspace: Schema.string().volatile(),
  tulpaUrl: Schema.string().default(TULPA_DEFAULT_URL).volatile(),
  tulpaBearer: Schema.string().volatile(),
  toolAllowlist: Schema.array(Schema.string()).default(DEFAULT_TOOLS_ALLOWLIST).volatile(),
  patchEnabled: Schema.boolean().default(false).volatile(),
});

// 解析配置文件
function resolveConfig(config: TulpaLiteConfig): ResolvedConfig {
  const workspace = config.workspace.get();
  const tulpaUrl = config.tulpaUrl.get();
  const tulpaBearer = config.tulpaBearer.get();
  if (!workspace) throw new Error('缺少配置项 workspace');
  if (!tulpaBearer) throw new Error('缺少配置项 tulpaBearer');
  return {
    ws: workspace,
    endpoint: tulpaUrl?.trim() || undefined,
    bearer: tulpaBearer,
    toolAllowlist: config.toolAllowlist.get(),
    patchEnabled: config.patchEnabled.get(),
  };
}


// 插件运行时配置（用于 apply() 的 config 参数，Ref 待解包）
interface TulpaLiteConfig {
  workspace: Ref<string | undefined>; // 工作空间路径（必填）
  tulpaUrl: Ref<string>; // Tulpa MCP 端点（默认本机 loopback）
  tulpaBearer: Ref<string | undefined>; // Tulpa MCP bearer 凭据（必填）
  toolAllowlist: Ref<string[]>; // 工具白名单：只保留这些工具 + 本插件注入的 qqtool 工具
  patchEnabled: Ref<boolean>; // 源码 patch 注入状态：true = 已注入，false = 未注入
}

// 解包后的普通值（apply 编排与下游统一消费，不再透传 Ref）
interface ResolvedConfig {
  ws: string;
  endpoint: string | undefined;
  bearer: string;
  toolAllowlist: string[];
  patchEnabled: boolean;
}

export { Config, resolveConfig, TULPA_DEFAULT_URL };
export type { ResolvedConfig, TulpaLiteConfig };
