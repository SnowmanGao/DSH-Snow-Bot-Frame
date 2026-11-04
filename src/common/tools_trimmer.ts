// =====================================================================
//  tools_trimmer.ts —— 工具白名单过滤
//
//  与 prompt_trimmer（删 sections）对称：本模块按白名单过滤 DSH 工具。
//
//  DSH 的工具以 schema 形式存在于 `system-prompt/assemble` 事件的
//  `assembly.tools` 数组里（每个元素含 name/description/parameters）。
//  `system-prompt/assemble` 是 waterfall 事件，监听器可改写返回的
//  assembly，因此能像删 sections 一样「只保留白名单内的工具」。
//
//  规则：allowlist 为空 → 不过滤；否则只保留 name 命中白名单的工具。
// =====================================================================

import type { Agent, Assembly } from './dsh_types.js';

type Tools = Assembly['tools'];

// 本插件注入的工具（始终保留，不受白名单影响）。
const MY_TOOL_NAMES = new Set([
  'qqbot_send_message',
  'qqtool_get_recent_messages',
  'qqtool_search_messages',
  'qqtool_get_message_context',
  'qqtool_get_message',
]);

// 联动插件（dsh-qqbot 官方）注册的工具，兜底保留。
const CO_TOOL_NAMES = new Set(['qqbot_send_file']);

// 纯函数：从 tools 里只保留白名单命中的工具
function trimAssemblyTools(tools: Tools, allowlist: string[]): Tools {
  // 白名单为空时，视为所有工具都允许
  if (!allowlist.length) return tools;
  if (tools === undefined) return [];

  // 额外包括 自有工具 和 qq_bot 官方工具
  const allow = new Set<string>([
    ...allowlist,
    ...MY_TOOL_NAMES,
    ...CO_TOOL_NAMES,
  ]);
  return tools.filter((tool) => allow.has(tool.name));
}

// 在 agent 上安装工具白名单过滤的监听器（system-prompt/assemble waterfall）
function installToolsTrimmer(agent: Agent, allowlist: string[]): void {
  if (!allowlist.length) return;
  agent.ctx.on(
    'system-prompt/assemble',
    async (_asm, _ctx, next: () => Promise<Assembly>) => {
      const assembled = await next();
      return { ...assembled, tools: trimAssemblyTools(assembled.tools, allowlist) };
    },
  );
}

export { trimAssemblyTools, installToolsTrimmer };
