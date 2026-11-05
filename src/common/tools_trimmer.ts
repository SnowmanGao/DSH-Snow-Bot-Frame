// =====================================================================
//  tools_trimmer.ts —— 工具白名单过滤
//
//  工具白名单双层防线：
//  1. trimAgentToolsByOfficial：注册表级（agent.ctx.tools.restrict），移除白名单外
//     的全局工具，同时影响可调用性、提示词 schema 与 skill 目录注入。但它只对
//     「当时已注册」的全局工具生效，之后动态注册的全局工具（如 subagent）会漏网。
//  2. trimAgentToolsByInject：注入级兜底，在 assemble 时按白名单过滤 assembly.tools，
//     把漏网的全局工具从提示词里藏掉。本插件 agent 作用域的自有工具始终保留。
// =====================================================================

import type { Agent } from './dsh_types.js';

// 本插件在 agent 作用域注册的自有工具：qqtool_*（历史/记忆）与 qqbot_send_message。
function isAgentOwnTool(name: string): boolean {
  return name === 'qqbot_send_message' || name.startsWith('qqtool_');
}

// 注册表级：restrict 移除白名单外的全局工具。agent 作用域工具自动保留。
function trimAgentToolsByOfficial(agent: Agent, allowlist: string[]): void {
  const tools = agent.ctx?.tools;
  if (!tools || typeof tools.restrict !== 'function') return;
  tools.restrict({ allow: [...allowlist] });
}

// 注入级兜底：按白名单过滤提示词里的工具 schema，藏掉 restrict 漏网的动态全局工具。
function trimAgentToolsByInject<T extends { name: string; }>(tools: T[] | undefined, allowlist: string[]): T[] | undefined {
  if (!tools?.length) return tools;
  const allow = new Set(allowlist);
  return tools.filter((t) => allow.has(t.name) || isAgentOwnTool(t.name));
}

export { trimAgentToolsByInject, trimAgentToolsByOfficial };
