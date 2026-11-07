// =====================================================================
//  tools_of_chat.ts —— 赋予 AI 自由发送消息的能力
//
//  阻止 QQ Bot 插件将 Assistant 文本自动发送到 QQ，并把发送时机的
//  控制权交给 AI（通过 qqbot_send_message 工具）。
//
//  ！通过修改文件、注入插件源代码实现，需重启 DSH 生效。
//  ！仅适配 @tencent-connect/dsh-qqbot@0.5.5，破坏性更新会导致失效。
// =====================================================================

import { SourcePatcher } from './common/source_patcher.js';
import { hydrateParameters, type ParamDef } from './common/tools_def_utils.js';
import type { ToolDef } from './common/dsh_types.js';
import { qqBotOutbound, qqBotBootstrap } from './bridge/paths.js';
import type { ResolvedGroup } from './group_resolver.js';
import { toolPrompts } from './prompt.js';

// 1. 抑制自动发送（durable 路径）：在 route() 里丢弃 assistant/tool 事件。
const neverAutoSendPatcher = new SourcePatcher({
  file: qqBotOutbound,
  before: [
    '        const event = parseEvent(raw);',
    '        if (event === undefined)',
    '            return;',
    '        const record = this.manager.findBySessionId(session.header.id);',
  ].join('\n'),
  after: [
    '        const event = parseEvent(raw);',
    '        if (event === undefined)',
    '            return;',
    "        if (['assistant/chunk', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type))",
    '            return;',
    '        const record = this.manager.findBySessionId(session.header.id);',
  ].join('\n'),
});

// 2. 抑制自动发送（流式路径）：新版 DSH 的 assistant 文本走 agent/assistant-stream
// 瞬态帧 → routeStreamFrame → buffer → turn/end flush。route() 的抑制管不到这条
// 路径，需在 routeStreamFrame 入口直接丢弃，buffer 不再累积文本。
const neverAutoStreamPatcher = new SourcePatcher({
  file: qqBotOutbound,
  before: [
    '    routeStreamFrame(agentId, delta) {',
    "        if (delta.kind === 'attempt-start') {",
  ].join('\n'),
  after: [
    '    routeStreamFrame(agentId, delta) {',
    '        return;',
    "        if (delta.kind === 'attempt-start') {",
  ].join('\n'),
});

// 3. 暴露文本发送服务：在 registerSendFileTool 之后，把 send 能力挂到 ctx 上，
// 供本插件在 agent 作用域注册 qqbot_send_message 工具（真隔离，避免全局工具）。
const agentSendToolPatcher = new SourcePatcher({
  file: qqBotBootstrap,
  before: '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
  // 清除历史版本的注入块（注释 → provide → `});`），防止 after 演进后残留叠加。
  clear: /    \/\/ ── 文本发送能力（dsh-snow-bot-frame 注入[\s\S]*?\n    \}\);/g,
  after: [
    '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
    '    // ── 文本发送能力（dsh-snow-bot-frame 注入：暴露服务，工具由插件按 agent 作用域注册） ──',
    "    ctx.reflect.provide('snowbotSendMessage', {",
    '      async send(content, target, exec, groupId) {',
    "        if (typeof content !== 'string' || content.trim().length === 0) {",
    "          throw new Error('qqbot_send_message: content must be a non-empty string');",
    '        }',
    '        const parseTarget = (input) => {',
    "          const idx = input.indexOf(':');",
    '          if (idx <= 0) return undefined;',
    '          const scope = input.slice(0, idx);',
    '          const targetId = input.slice(idx + 1);',
    "          if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;",
    '          return { scope, targetId };',
    '        };',
    '        let replyTarget;',
    "        if (target !== undefined && target !== '') {",
    '          replyTarget = parseTarget(target);',
    "          if (replyTarget === undefined) throw new Error('qqbot_send_message: target 格式错误，需要 c2c:openid 或 group:openid，收到: ' + target);",
    '        }',
    '        else if (exec && exec.agent !== undefined) {',
    "          replyTarget = manager.findByAgent(exec.agent)?.replyTarget;",
    '        }',
    '        if (replyTarget === undefined) {',
    "          throw new Error('qqbot_send_message: 无法确定发送目标，请显式传 target 参数');",
    '        }',
    "        const limit = config.textChunkLimit;",
    "        const { chunkMarkdownText } = await import('../transport/chunker.js');",
    '        const chunks = chunkMarkdownText(content, limit);',
    '        // 一次只发一块：超过阈值只发第一块（截断），不拆分发送。',
    '        const chunk = chunks[0];',
    '        const truncated = chunks.length > 1;',
    '        await sender.sendMarkdown(replyTarget, chunk);',
    '        // target：群聊优先用插件学习出的纯数字群号，未学习时静默回退到原始 openid。',
    "        const targetId = (replyTarget.scope === 'group' && groupId) ? groupId : replyTarget.targetId;",
    "        const result = truncated ? ('发送已截断（本次仅发送前 ' + limit + ' 字符）') : '发送成功';",
    "        logger.info('[snow-bot] qqbot_send_message → ' + replyTarget.scope + ':' + targetId + (truncated ? '（已截断）' : ''));",
    "        return { result: result, target: replyTarget.scope + ':' + targetId };",
    '      },',
    '    });',
  ].join('\n'),
});

// 按 patchEnabled 统一注入/还原三个 patch（幂等）。
function applyPatches(enabled: boolean): void {
  const patchers = [neverAutoSendPatcher, neverAutoStreamPatcher, agentSendToolPatcher];
  for (const p of patchers) {
    if (enabled) p.inject();
    else p.revert();
  }
}

// qqbot_send_message 工具定义（在 agent 作用域注册）。
// send 来自 patch 暴露的 snowbotSendMessage 服务；description 与参数 schema 在 prompt.ts。
function createSendMessageTool(
  send: (content: string, target: string | undefined, exec: unknown, groupId: string | undefined) => Promise<{ result: string; target: string }>,
  getOpenid: () => string | undefined,
  resolveGroup: (openid: string) => ResolvedGroup | undefined,
): ToolDef {
  const { description, parameters } = toolPrompts.qqbot_send_message;
  // 参数结构（type/required）。
  const paramDefs: Record<string, ParamDef> = {
    content: { type: 'string', required: true },
  };
  return {
    name: 'qqbot_send_message',
    description,
    parameters: hydrateParameters(parameters, paramDefs),
    output: {
      schema: {
        type: 'object',
        properties: { result: { type: 'string' }, target: { type: 'string' } },
        required: ['result', 'target'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { content: string; target?: string }, exec: unknown) {
      // 群号优先用已学习出的纯数字群号，未学习则回退 openid（在 send 内处理）。
      const openid = getOpenid();
      const group = openid ? resolveGroup(openid) : undefined;
      return send(args?.content, args?.target, exec, group?.groupId);
    },
  };
}

export { agentSendToolPatcher, applyPatches, createSendMessageTool, neverAutoSendPatcher, neverAutoStreamPatcher };
