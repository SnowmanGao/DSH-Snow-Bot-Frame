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

// 纯函数：从 tools 里只保留白名单命中的工具。
function trimAssemblyTools(tools: Tools, allowlist: string[]): Tools {
  if (!allowlist.length) return tools;
  const allow = new Set(allowlist);
  return (tools ?? []).filter((tool) => allow.has(tool.name));
}

// 在 agent 上安装工具白名单过滤的监听器（system-prompt/assemble waterfall）。
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
