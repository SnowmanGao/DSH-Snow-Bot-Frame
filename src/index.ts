import { mkdir } from 'node:fs/promises';
import { groupPrompt, historyDescriptions, QQ_DROP_SECTIONS, QQ_DROP_CONTEXTS, QQ_CONTEXT_COMPACT } from './prompt.js';
import { registerConfigRoutes, type TulpaLiteConfig } from './config_forms.js';
import { connectorTransport } from './mcp_linker.js';
import type { Agent, Ctx } from './common/dsh_types.js';
import { trimAssemblySections, trimAssemblyContexts, keepByPrefix, compactByTransforms } from './common/prompt_trimmer.js';
import { installToolsTrimmer } from './common/tools_trimmer.js';
import { openidForSessionId } from './qqbot_prefs.js';
import { groupResolver, type ResolvedGroup } from './group_resolver.js';
import { NeverAutoSendPatcher, AgentSendToolPatcher } from './tools_of_chat.js';
import { History } from './tools_of_history.js';


// 从 user/message 事件数据里抽取纯文本（agentBody）。
function extractText(data: unknown): string {
  const blocks = (data as any)?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

// 4 个历史工具的 execute：从 openid 解析所属群，走 Tulpa 读本群历史。
function toolDefs(bearer: string, url: string | undefined, openid: string, resolveGroup: (openid: string) => Promise<ResolvedGroup | undefined>) {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const output = { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };
  const object = (properties: Record<string, unknown>, required?: string[]) =>
  ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });

  const parameters = {
    qqtool_get_recent_messages: object({ limit: int, cursor: str }),
    qqtool_search_messages: object({ start: str, end: str, sender: str, keyword: str, limit: int, cursor: str }),
    qqtool_get_message_context: object({ id: int, before: int, after: int }, ['id']),
    qqtool_get_message: object({ id: int }, ['id']),
  };
  type ToolName = keyof typeof parameters;

  const run = async (name: ToolName, args: any) => {
    const group = await resolveGroup(openid);
    if (!group) throw new Error('尚未识别出所属群（Tulpa 配对未成功），请稍后重试');
    const binding = { platform: 'qq', conversation_id: group.conversationId };
    const t = await connectorTransport({ bearer, url });
    try {
      const h = new History(t, binding);
      switch (name) {
        case 'qqtool_get_recent_messages': return await h.recentMessages(args);
        case 'qqtool_search_messages': return await h.searchMessages(args);
        case 'qqtool_get_message_context': return await h.messageContext(args);
        case 'qqtool_get_message': return await h.readMessage(args);
      }
    } finally {
      await t.close();
    }
  };

  return (Object.keys(parameters) as ToolName[]).map(name => ({
    name,
    description: historyDescriptions[name],
    parameters: parameters[name],
    output,
    async execute(args: any) { return run(name, args); },
  }));
}


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

  const resolver = groupResolver(bearer, endpoint);

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
  // 两个 patch 成对：抑制自动发送 + 注入主动发送工具（显式输出架构的两半）。
  if (patchEnabled) {
    NeverAutoSendPatcher.inject();
    AgentSendToolPatcher.inject();
  } else {
    NeverAutoSendPatcher.revert();
    AgentSendToolPatcher.revert();
  }

  // 每个已挂载钩子的 agent 记录（幂等）。
  const hooked = new Set<string>();

  // 从 session/event 识别 QQ 群会话：prefs 反向查 openid，命中的即群聊。
  // 首条消息时挂载工具 + 提示词钩子；此后每轮把最新消息喂给解析器（供学习）。
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
    hookAgent(agent, openid);
  });

  function hookAgent(agent: Agent, openid: string) {
    const defs = toolDefs(bearer, endpoint, openid, (o) => resolver.resolve(o));

    // 工具：agent 作用域注册（仅本群会话可见，不进全局工具目录）。
    const tools = agent.ctx?.tools;
    if (tools && typeof tools.register === 'function') {
      for (const def of defs) tools.register(def);
    }

    // 工具白名单：只保留配置的工具 + 本插件注入的 4 个 qqtool 工具。
    installToolsTrimmer(agent, [...toolAllowlist, ...defs.map(d => d.name)]);

    // 提示词裁剪 + 群提示词注入：单个 system-prompt/assemble 监听器统一处理。
    //   ① 删内置 DROP section（部署/开发/Web 态）+ 用户 trimSections
    //   ② tool: 前缀 section 只保留 toolAllowlist 命中的工具说明段
    //   ③ 删 development-only context + 精简 runtime-context 三项
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      const group = await resolver.resolve(openid);
      // 尚未识别出群：本轮不裁剪也不注入，下轮再试
      if (!group) return assembled;

      // 会话标题：每轮校正为群名。
      const st = ctx.get('sessionTitle');
      if (st?.rename && st?.get) {
        try {
          if (st.get(agent.session)?.title !== group.groupName) st.rename(agent.session, group.groupName);
        } catch { /* 标题服务不可用时跳过 */ }
      }

      const sections = trimAssemblySections(assembled.sections, [...QQ_DROP_SECTIONS, ...trimSections]);
      const keptSections = keepByPrefix(sections, 'tool:', toolAllowlist);
      const contexts = compactByTransforms(trimAssemblyContexts(assembled.contexts, QQ_DROP_CONTEXTS), QQ_CONTEXT_COMPACT);
      const text = groupPrompt(group, ws);
      return {
        ...assembled,
        sections: [...(keptSections ?? []), { name: 'qq-group:context', order: 90, text }],
        contexts,
      };
    });
  }
}

export { apply };
export { Config } from './config_forms.js';
