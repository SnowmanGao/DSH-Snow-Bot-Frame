// =====================================================================
//  runtime.ts —— 会话运行时：按 agent 挂载的钩子 + 事件处理
//
//  入口编排见 index.ts。本文件定义按 QQ agent 挂载的钩子（agent 作用域）：
//   1. agent/created —— 注册工具（qqtool_*）+ 注册表级白名单 + 提示词注入钩子
//   2. agent/inbox/claimed —— 早于 system-prompt/assemble，记录学习素材并异步学习
//   3. system-prompt/assemble —— 裁剪 section/context + 切工作目录 + 注入群提示词
// =====================================================================

import { mkdir } from 'node:fs/promises';
import { systemPromptBuilder, SECTIONS_TO_DROP, SECTIONS_TO_COMPACT, CONTEXTS_TO_DROP, workDir } from './prompt.js';
import { openidForSessionId } from './bridge/qqbot_prefs.js';
import type { Agent, Ctx } from './common/dsh_types.js';
import { trimAssemblySections, trimAssemblyContexts, compactByTransforms } from './common/prompt_trimmer.js';
import { trimAgentToolsByInject, trimAgentToolsByOfficial } from './common/tools_trimmer.js';
import { createSendMessageTool } from './tools_of_chat.js';
import { createHistoryTools } from './tools_of_history.js';
import { createMediaTools } from './tools_of_media.js';
import { createMemoryTools, ensureGroupFiles } from './tools_of_memory.js';
import { dbg } from './common/debug_log.js';
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


// ========================== 依赖 ==========================

interface HookDeps {
  ctx: Ctx;
  cfg: ResolvedConfig;
  mcp: TulpaMcp;
  resolver: GroupResolver;
}

type AgentHook = (agent: Agent, deps: HookDeps) => void;

// 懒解析 agent 所属 QQ 群 openid（新会话 prefs 未落盘时返回 undefined）。
function openidForAgent(agent: Agent | undefined | null): string | undefined {
  if (!agent) return undefined;
  return openidForSessionId(agent.session?.id ?? agent.id);
}

// 判断是否为 QQ 群会话：im-qqbot 把 agent cwd 固定为配置的 workspace
// （create 传 meta.cwd，resume 沿用持久化 header，两者一致）。
function isQQAgent(agent: Agent, cfg: ResolvedConfig): boolean {
  const cwd = agent.session?.header?.cwd;
  if (typeof cwd !== 'string') return false;
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return norm(cwd) === norm(cfg.ws);
}


// ========================== 工具挂钩 ==========================

// 挂钩 0：注册表级工具白名单（restrict，官方 API）。移除白名单外的全局工具，
// 顺带屏蔽 skill 目录注入（dsh-tool-skill 检查 skill 工具是否可见）。
const restrictToolsHook: AgentHook = (agent, deps) => {
  try {
    trimAgentToolsByOfficial(agent, deps.cfg.toolAllowlist);
    dbg('[snow-bot] 注册表级工具白名单已应用', agent.id);
  } catch (e) {
    dbg('[snow-bot] 注册表级工具白名单失败：', String(e));
  }
};

// 挂钩 1：注册文本发送工具（qqbot_send_message，agent 作用域）。
const chatToolsHook: AgentHook = (agent, deps) => {
  let send: ((content: string, target: string | undefined, exec: unknown, groupId: string | undefined) => Promise<{ result: string; target: string; }>) | undefined;
  try { send = deps.ctx.get('snowbotSendMessage')?.send; } catch { /* 服务未提供 */ }
  if (typeof send !== 'function') { dbg('[snow-bot] QQ 发送服务不可用（未启用 patch 或 dsh-qqbot 未加载）'); return; }
  const tools = agent.ctx?.tools;
  if (tools && typeof tools.register === 'function') {
    tools.register(createSendMessageTool(send, () => openidForAgent(agent), (o) => deps.resolver.resolveCached(o)));
    dbg('[snow-bot] 文本发送工具已注册', agent.id);
  }
};

// 挂钩 2：注册 4 个 qqtool 历史工具。
const historyToolsHook: AgentHook = (agent, deps) => {
  const getOpenid = () => openidForAgent(agent);
  const defs = createHistoryTools(deps.mcp, getOpenid, (o) => deps.resolver.resolve(o));
  const tools = agent.ctx?.tools;
  if (tools && typeof tools.register === 'function') {
    for (const def of defs) tools.register(def);
    dbg('[snow-bot] 历史工具已注册', agent.id);
  }
};

// 挂钩 2.5：注册 qqtool_fetch_media 媒体工具（图片按需下载 + 语音转写）。
const mediaToolsHook: AgentHook = (agent, deps) => {
  const getOpenid = () => openidForAgent(agent);
  const defs = createMediaTools(deps.mcp, getOpenid, (o) => deps.resolver.resolve(o), deps.cfg.ws);
  const tools = agent.ctx?.tools;
  if (tools && typeof tools.register === 'function') {
    for (const def of defs) tools.register(def);
    dbg('[snow-bot] 媒体工具已注册', agent.id);
  }
};

// 挂钩 3：注册记忆工具（qqtool_archive_group_logs）。
const memoryToolsHook: AgentHook = (agent, deps) => {
  const getOpenid = () => openidForAgent(agent);
  const defs = createMemoryTools(getOpenid, (o) => deps.resolver.resolve(o), deps.cfg.ws);
  const tools = agent.ctx?.tools;
  if (tools && typeof tools.register === 'function') {
    for (const def of defs) tools.register(def);
    dbg('[snow-bot] 记忆工具已注册', agent.id);
  }
};

// ========================== 提示词 / 工作目录  ==========================

// 在 agent 作用域注册 system-prompt/assemble 监听器。回调用闭包 agent 识别
// 会话。这里做：工具白名单注入级兜底（始终生效）+ 群已学习出 → 切工作目录
// + 校正标题 + 裁剪 + 注入群提示词。
const promptHook: AgentHook = (agent, deps) => {
  let lastGroupId: string | undefined; // 上一次注入的群：日志降频，仅群对象变化时打印
  agent.ctx.on('system-prompt/assemble', async (_assembly: any, _context: any, next: () => Promise<any>) => {
    const assembled = await next();
    const openid = openidForAgent(agent);
    // openid 尚未就绪：本轮不注入，下轮再试
    if (!openid) return assembled;

    // 工具白名单注入级兜底：对 QQ 会话始终生效，不依赖群学习结果。
    let result: any = { ...assembled, tools: trimAgentToolsByInject(assembled.tools, deps.cfg.toolAllowlist) };

    // 解析群映射：await (复用 onInboxClaimed 已启动的同一个 promise)
    // 先延迟 3s 等消息入库再匹配，最多只等 8.0s
    const group = await deps.resolver.resolveBounded(openid, 8000);
    if (!group) return result;

    try {
      // 群目录基础文件（SOUL.md、MEMORY.md）首次缺失时补建，幂等。
      ensureGroupFiles(group.groupId, deps.cfg.ws);

      // 隔离：把会话工作目录切到本群目录（复用官方 workingDirectory 服务）。
      const wd = deps.ctx.get('workingDirectory');
      if (wd && typeof wd.set === 'function') {
        try {
          await wd.set(agent, workDir(group.groupId, deps.cfg.ws), _context.signal);
        } catch (e) {
          dbg('[snow-bot] 设置本群工作目录失败：', String(e));
        }
      }

      // 会话标题：校正为群名。
      const st = deps.ctx.get('sessionTitle');
      if (st?.rename && st?.get) {
        try {
          if (st.get(agent.session)?.title !== group.groupName) st.rename(agent.session, group.groupName);
        } catch { /* 标题服务不可用时跳过 */ }
      }

      // 条件渲染的段随工具移除自动卸载。
      // 静态的 tool:bash 和 tool:pwsh 是特例，只能始终保留（短，可接受）。
      const sections = compactByTransforms(trimAssemblySections(result.sections, SECTIONS_TO_DROP), SECTIONS_TO_COMPACT);
      const contexts = trimAssemblyContexts(result.contexts, CONTEXTS_TO_DROP);
      const text = systemPromptBuilder(group);
      // waterfall 返回后仍需排序：仅靠 order 字段无法保证提示词排在开头，
      // 因此不得不把群提示词放到数组最前，使其优先于其他 section。
      result = {
        ...result,
        sections: [{ name: 'qq-group:context', order: -1e4, text }, ...(sections ?? [])],
        contexts,
      };
      if (group.groupId !== lastGroupId) {
        dbg('[snow-bot] 已注入群提示词', openid, '→', group.groupId, group.groupName);
        lastGroupId = group.groupId;
      }
    } catch (e) {
      dbg('[snow-bot] 组装群提示词失败：', String(e));
    }
    return result;
  });
};

// 挂钩注册表：新增能力在此追加一行。
const agentHooks: AgentHook[] = [restrictToolsHook, chatToolsHook, historyToolsHook, mediaToolsHook, memoryToolsHook, promptHook];


// ========================== 会话运行时 ==========================

interface Runtime {
  deps: HookDeps;
  workspaceTitle: string;
  attached: Set<string>; // 已归入工作区的会话（幂等）
  hooked: Set<Agent>;    // 已挂载工具挂钩的 agent（幂等，agent 对象唯一）
}

// 给单个 QQ 群 agent 挂载全部钩子（工具 + 提示词/工作目录/白名单，幂等）。
// 失败只告警不抛出：agent/created 是 serial 事件，抛错会中断 agent 创建。
function attachAgentHooks(rt: Runtime, agent: Agent): void {
  if (!isQQAgent(agent, rt.deps.cfg)) return;
  if (rt.hooked.has(agent)) return;
  rt.hooked.add(agent);
  for (const hook of agentHooks) {
    try {
      hook(agent, rt.deps);
    } catch (e) {
      dbg('[snow-bot] 挂载 agent 钩子失败：', String(e));
    }
  }
}

// 归入 QQAgent 工作区（幂等，失败自动重试）。
async function ensureWorkspace(rt: Runtime, sessionId: string): Promise<void> {
  if (rt.attached.has(sessionId)) return;
  const registry = rt.deps.ctx.get('workspaceRegistry');
  if (!registry || typeof registry.create !== 'function') return;
  try {
    await mkdir(rt.deps.cfg.ws, { recursive: true });
    const entity = await registry.create(rt.deps.cfg.ws, rt.workspaceTitle);
    if (typeof entity.setTitle === 'function' && entity.title !== rt.workspaceTitle) {
      await entity.setTitle(rt.workspaceTitle);
    }
    if (typeof entity.attachSession === 'function') await entity.attachSession(sessionId);
    rt.attached.add(sessionId);
  } catch (e) { dbg('[snow-bot] 会话归入工作区失败：', String(e)); }
}

// 学习素材入口：在 agent/inbox/claimed（早于 system-prompt/assemble）记录真实
// 用户消息，并异步触发群配对学习（结果缓存，供下一轮 assemble 注入）。
function onInboxClaimed(rt: Runtime, agent: Agent, message: any) {
  const openid = openidForAgent(agent);
  if (!openid) return;
  if (message?.source?.kind !== 'user') return;
  const text = extractText(message);
  rt.deps.resolver.noteMessage(openid, text, Date.now());
  // 异步学习（不阻塞本轮；学成后写 learned-groups.json + 内存缓存）
  void rt.deps.resolver.resolve(openid).then((g) => {
    if (g) dbg('[snow-bot] 群学习完成：', openid, '→', g.groupId, g.groupName);
  });
}

// 事件回调：识别 QQ 群会话，归入 QQAgent 工作区。
function onSessionEvent(rt: Runtime, session: any, event: any) {
  if (event?.type !== 'user/message' || event?.surfaceOp !== 'append') return;
  const sessionId: string | undefined = session?.header?.id;
  if (!sessionId) return;
  const openid = openidForSessionId(sessionId);
  if (!openid) return;
  void ensureWorkspace(rt, sessionId);
}

// 注册 DSH 的 ctx 事件监听，并为遗漏的 agent 补注册。
// 重启或热重载后，已存在的会话不会重新触发 agent/created，需在首个 turn 之前补挂。
function registerEvents(rt: Runtime): void {
  const ctx = rt.deps.ctx;

  // 补挂现存 agent。
  const agents = ctx.get('agents');
  if (typeof agents?.list === 'function') {
    const existing = agents.list();
    dbg('[snow-bot] 补挂现存 agent 数：', Array.isArray(existing) ? existing.length : '(未知)');
    for (const agent of existing) attachAgentHooks(rt, agent as Agent);
  }

  ctx.on('agent/created', ({ agent }: { agent: Agent; }) => {
    dbg('[snow-bot] agent/created：', agent.id, 'cwd=', agent.session?.header?.cwd);
    attachAgentHooks(rt, agent);
  });

  // agent/inbox/claimed 早于 system-prompt/assemble，首条消息即触发学习。
  ctx.on('agent/inbox/claimed', ({ agent, message }: { agent: Agent; message: unknown; }) => onInboxClaimed(rt, agent, message));

  ctx.on('session/event', (session, event) => onSessionEvent(rt, session, event));
}

export { registerEvents };
export type { HookDeps, Runtime };
