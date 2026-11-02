// =====================================================================
//  plugin.ts —— 插件本体：apply 装配 + agent 挂钩注册表
//
//  职责：读配置 → 建 GroupResolver → 工作区归档 → 配置面板路由 →
//  qqbot 源码 patch → 监听 session/event，首个 QQ 群消息时给 agent
//  挂钩（hooks 数组，新增能力 = 加一个 hook + bridge 加一个文件）。
//
//  外部系统通信统一在 bridge/；通用裁剪纯函数在 common/。
//  入口见 index.ts（仅 re-export）。
// =====================================================================

import { mkdir } from 'node:fs/promises';
import { groupPrompt, QQ_DROP_SECTIONS, QQ_DROP_CONTEXTS, QQ_CONTEXT_COMPACT } from './prompt.js';
import { type TulpaLiteConfig } from './config_schema.js';
import { registerConfigRoutes } from './bridge/config_routes.js';
import { openidForSessionId } from './bridge/qqbot_prefs.js';
import { TulpaMcp } from './bridge/tulpa_mcp.js';
import { applyPatches } from './tools_of_chat.js';
import type { Agent, Ctx } from './common/dsh_types.js';
import { trimAssemblySections, trimAssemblyContexts, keepByPrefix, compactByTransforms } from './common/prompt_trimmer.js';
import { installToolsTrimmer } from './common/tools_trimmer.js';
import { GroupResolver } from './group_resolver.js';
import { createHistoryTools } from './tools_of_history.js';


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
// 每个挂钩拿到 (agent, openid, deps)；apply 主流程不感知具体能力。

// 传递给挂钩的装配期依赖。
interface HookDeps {
  ctx: Ctx;
  ws: string;
  mcp: TulpaMcp;
  trimSections: string[];
  toolAllowlist: string[];
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
  installToolsTrimmer(agent, [...deps.toolAllowlist, ...defs.map(d => d.name)]);
};

// 挂钩 2：提示词裁剪 + 群提示词注入（单个 system-prompt/assemble 监听器统一处理）。
//   ① 删内置 DROP section（部署/开发/Web 态）+ 用户 trimSections
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

    const sections = trimAssemblySections(assembled.sections, [...QQ_DROP_SECTIONS, ...deps.trimSections]);
    const keptSections = keepByPrefix(sections, 'tool:', deps.toolAllowlist);
    const contexts = compactByTransforms(trimAssemblyContexts(assembled.contexts, QQ_DROP_CONTEXTS), QQ_CONTEXT_COMPACT);
    const text = groupPrompt(group, deps.ws);
    return {
      ...assembled,
      sections: [...(keptSections ?? []), { name: 'qq-group:context', order: 90, text }],
      contexts,
    };
  });
};

// 挂钩注册表：新增能力在此追加一行。
const agentHooks: AgentHook[] = [historyToolsHook, promptHook];


// ---- 插件装配 ----

function apply(ctx: Ctx, config: TulpaLiteConfig) {

  const workspace = config.workspace.get();
  const tulpaUrl = config.tulpaUrl.get();
  const tulpaBearer = config.tulpaBearer.get();
  if (!workspace) throw new Error('缺少配置项 workspace');
  if (!tulpaBearer) throw new Error('缺少配置项 tulpaBearer');
  // 显式收窄为 string（避免闭包里丢失控制流收窄），供下方嵌套函数使用。
  const ws: string = workspace;
  const bearer: string = tulpaBearer;
  const endpoint: string | undefined = tulpaUrl?.trim() || undefined;
  const trimSections = config.trimSections.get();
  const toolAllowlist = config.toolAllowlist.get();
  const patchEnabled = config.patchEnabled.get();

  // 唯一的 Tulpa 连接入口：bearer/url 在此收敛，下游（GroupResolver、
  // createHistoryTools、领域查询）一律收 TulpaMcp 实例，不再透传二元组。
  const mcp = new TulpaMcp({ bearer, url: endpoint });
  const resolver = new GroupResolver(mcp);
  const deps: HookDeps = { ctx, ws, mcp, trimSections, toolAllowlist, resolver };

  // 在首个 QQ 群消息到达（即首个对话创建）时，
  // 用 workspaceRegistry 抢先创建名为 "QQAgent" 的 workspace，防止显示为 "未分组对话"
  const workspaceTitle = ws.split(/[\\/]/).filter(Boolean).pop() ?? 'QQAgent';
  const attached = new Set<string>();
  async function ensureWorkspace(sessionId: string): Promise<void> {
    if (attached.has(sessionId)) return;
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.create !== 'function') return;
    try {
      await mkdir(ws, { recursive: true }); // create 要求目录已存在，否则 realpath 抛 ENOENT
      const entity = await registry.create(ws, workspaceTitle); // 已存在则复用（幂等）
      if (typeof entity.setTitle === 'function' && entity.title !== workspaceTitle) {
        await entity.setTitle(workspaceTitle); // 校正标题为 "QQAgent"
      }
      if (typeof entity.attachSession === 'function') await entity.attachSession(sessionId);
      attached.add(sessionId);
    } catch (e) { ctx.logger?.warn?.(`[snow-bot] 会话 ${sessionId} 归入工作区失败：${String(e)}`); }
  }

  // 配置面板数据通道：desktop 端没有 configForms，改走 host 路由 + client fetch。
  // learned 附带已自动学习到的群映射（只读，供用户核对零手填效果）。
  registerConfigRoutes(ctx, () => ({
    workspace: ws, tulpaUrl: endpoint ?? '', tulpaBearer: bearer, trimSections, toolAllowlist, patchEnabled,
    learned: resolver.listLearned(),
  }));

  // 源码 patch：按 GUI 的 patchEnabled 注入、还原（改 im-qqbot 的 dist，需重启 DSH 生效）。
  applyPatches(patchEnabled);

  // 每个已挂载钩子的 agent 记录（幂等）。
  const hooked = new Set<string>();

  // 从 session/event 识别 QQ 群会话：prefs 反向查 openid，命中的即群聊。
  // 首条消息时挂载挂钩；此后每轮把最新消息喂给解析器（供学习）。
  ctx.on('session/event', (session: any, event: any) => {
    if (event?.type !== 'user/message' || event?.surfaceOp !== 'append') return;
    const sessionId: string | undefined = session?.header?.id;
    if (!sessionId) return;
    const openid = openidForSessionId(sessionId);
    if (!openid) return;

    const text = extractText(event.data);
    const time = typeof event.time === 'number' ? event.time : Date.now();
    resolver.noteMessage(openid, text, time);
    void ensureWorkspace(sessionId); // 归入 QQAgent 工作区（幂等，失败自动重试）

    if (hooked.has(sessionId)) return;
    const agents = ctx.get('agents');
    const agent: Agent | undefined = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
    if (!agent) return;
    hooked.add(sessionId);
    for (const hook of agentHooks) hook(agent, openid, deps);
  });
}

export { apply };
