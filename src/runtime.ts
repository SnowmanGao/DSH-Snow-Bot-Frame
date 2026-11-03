// =====================================================================
//  runtime.ts —— 会话运行时：session/event 处理 + agent 挂钩注册表
//
//  入口编排在 index.ts（resolveConfig → 组装 mcp/resolver/deps/rt →
//  注册路由 → applyPatches → 监听事件）；本文件只做「事件驱动」的
//  执行逻辑：识别 QQ 群会话、喂消息给解析器、归入工作区、给 agent 挂
//  钩（agentHooks 数组，新增能力 = 加一个 hook + bridge 加一个文件）。
// =====================================================================

import { mkdir } from 'node:fs/promises';
import { groupPrompt, QQ_DROP_SECTIONS, QQ_DROP_CONTEXTS, QQ_CONTEXT_COMPACT } from './prompt.js';
import { openidForSessionId } from './bridge/qqbot_prefs.js';
import type { Agent, Ctx } from './common/dsh_types.js';
import { trimAssemblySections, trimAssemblyContexts, keepByPrefix, compactByTransforms } from './common/prompt_trimmer.js';
import { installToolsTrimmer } from './common/tools_trimmer.js';
import { createHistoryTools } from './tools_of_history.js';
import type { ResolvedConfig } from './config_schema.js';
import type { TulpaMcp } from './bridge/tulpa_mcp.js';
import type { GroupResolver } from './group_resolver.js';


// 从 user/message 事件数据里抽取纯文本（agentBody）。
function extractText(data: unknown): string {
  const blocks = (data as any)?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}


// ---- agent 挂钩 ----
// 每个挂钩拿到 (agent, openid, deps)；事件主流程不感知具体能力。

// 传递给挂钩的装配期依赖。
interface HookDeps {
  ctx: Ctx;
  cfg: ResolvedConfig;
  mcp: TulpaMcp;
  resolver: GroupResolver;
}

type AgentHook = (agent: Agent, openid: string, deps: HookDeps) => void;

// 挂钩 1：注册 4 个 qqtool 历史工具 + 工具白名单。
//   工具：agent 作用域注册（仅本群会话可见，不进全局工具目录）；
//   白名单：只保留配置的工具 + 本插件注入的工具。
const historyToolsHook: AgentHook = (agent, openid, deps) => {
  const defs = createHistoryTools(deps.mcp, openid, (o) => deps.resolver.resolve(o));
  const tools = agent.ctx?.tools;
  if (tools && typeof tools.register === 'function') {
    for (const def of defs) tools.register(def);
  }
  installToolsTrimmer(agent, [...deps.cfg.toolAllowlist, ...defs.map(d => d.name)]);
};

// 挂钩 2：提示词裁剪 + 群提示词注入（单个 system-prompt/assemble 监听器统一处理）。
//   ① 删内置 DROP section（部署/开发/Web 态，见 prompt.ts 的 QQ_DROP_SECTIONS）
//   ② tool: 前缀 section 只保留 toolAllowlist 命中的工具说明段
//   ③ 删 development-only context + 精简 runtime-context 三项
//   ④ 注入本群提示词（WorkDir、记忆规则）；会话标题校正为群名
const promptHook: AgentHook = (agent, openid, deps) => {
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    const group = await deps.resolver.resolve(openid);
    // 尚未识别出群：本轮不裁剪也不注入，下轮再试
    if (!group) return assembled;

    // 会话标题：每轮校正为群名。
    const st = deps.ctx.get('sessionTitle');
    if (st?.rename && st?.get) {
      try {
        if (st.get(agent.session)?.title !== group.groupName) st.rename(agent.session, group.groupName);
      } catch { /* 标题服务不可用时跳过 */ }
    }

    const sections = trimAssemblySections(assembled.sections, QQ_DROP_SECTIONS);
    const keptSections = keepByPrefix(sections, 'tool:', deps.cfg.toolAllowlist);
    const contexts = compactByTransforms(trimAssemblyContexts(assembled.contexts, QQ_DROP_CONTEXTS), QQ_CONTEXT_COMPACT);
    const text = groupPrompt(group, deps.cfg.ws);
    return {
      ...assembled,
      sections: [...(keptSections ?? []), { name: 'qq-group:context', order: 90, text }],
      contexts,
    };
  });
};

// 挂钩注册表：新增能力在此追加一行。
const agentHooks: AgentHook[] = [historyToolsHook, promptHook];


// ---- 会话运行时 ----

// 一次 apply 装配出的运行时状态（index.ts 创建并传入事件处理器）。
interface Runtime {
  deps: HookDeps;
  workspaceTitle: string;
  attached: Set<string>; // 已归入工作区的会话（幂等）
  hooked: Set<string>;   // 已挂载挂钩的会话（幂等）
}

// 归入 QQAgent 工作区（幂等，失败自动重试）。workspaceRegistry 在首个
// 会话创建前抢先建 workspace，防止显示为「未分组对话」。
async function ensureWorkspace(rt: Runtime, sessionId: string): Promise<void> {
  if (rt.attached.has(sessionId)) return;
  const registry = rt.deps.ctx.get('workspaceRegistry');
  if (!registry || typeof registry.create !== 'function') return;
  try {
    await mkdir(rt.deps.cfg.ws, { recursive: true }); // create 要求目录已存在，否则 realpath 抛 ENOENT
    const entity = await registry.create(rt.deps.cfg.ws, rt.workspaceTitle); // 已存在则复用（幂等）
    if (typeof entity.setTitle === 'function' && entity.title !== rt.workspaceTitle) {
      await entity.setTitle(rt.workspaceTitle); // 校正标题为 "QQAgent"
    }
    if (typeof entity.attachSession === 'function') await entity.attachSession(sessionId);
    rt.attached.add(sessionId);
  } catch (e) { rt.deps.ctx.logger?.warn?.(`[snow-bot] 会话 ${sessionId} 归入工作区失败：${String(e)}`); }
}

// session/event 入口：识别 QQ 群会话（prefs 反向查 openid），
// 首条消息时挂载挂钩；此后每轮把最新消息喂给解析器（供学习）。
function onSessionEvent(rt: Runtime, session: any, event: any) {
  if (event?.type !== 'user/message' || event?.surfaceOp !== 'append') return;
  const sessionId: string | undefined = session?.header?.id;
  if (!sessionId) return;
  const openid = openidForSessionId(sessionId);
  if (!openid) return;

  const text = extractText(event.data);
  const time = typeof event.time === 'number' ? event.time : Date.now();
  rt.deps.resolver.noteMessage(openid, text, time);
  void ensureWorkspace(rt, sessionId); // 归入 QQAgent 工作区（幂等，失败自动重试）

  if (rt.hooked.has(sessionId)) return;
  const agents = rt.deps.ctx.get('agents');
  const agent: Agent | undefined = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  if (!agent) return;
  rt.hooked.add(sessionId);
  for (const hook of agentHooks) hook(agent, openid, rt.deps);
}

export { onSessionEvent };
export type { HookDeps, Runtime };
