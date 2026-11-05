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
import { qqBotOutbound, qqBotBootstrap } from './bridge/paths.js';

// 1. 抑制自动发送：在 route() 里丢弃自动输出事件。
// 参见 dsh-qqbot@0.5.5 outbound.js 的 route 函数。
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

// 2. 暴露文本发送服务：在 registerSendFileTool 之后，把 send 能力挂到 ctx 上，
// 供本插件在 agent 作用域注册 qqbot_send_message 工具（真隔离，避免全局工具）。
const agentSendToolPatcher = new SourcePatcher({
  file: qqBotBootstrap,
  before: '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
  after: [
    '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
    '    // ── 文本发送能力（dsh-snow-bot-frame 注入：暴露服务，工具由插件按 agent 作用域注册） ──',
    "    ctx.reflect.provide('snowbotSendMessage', {",
    '      async send(content, target, exec) {',
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
    "        const { chunkMarkdownText } = await import('../transport/chunker.js');",
    '        const chunks = chunkMarkdownText(content, config.textChunkLimit);',
    '        for (const chunk of chunks) {',
    '          await sender.sendMarkdown(replyTarget, chunk);',
    '        }',
    "        logger.info('[snow-bot] qqbot_send_message 发送 ' + chunks.length + ' 条 → ' + replyTarget.scope + ':' + replyTarget.targetId);",
    "        return { sent: chunks.length, target: replyTarget.scope + ':' + replyTarget.targetId };",
    '      },',
    '    });',
  ].join('\n'),
});

// 按 patchEnabled 统一注入/还原两个 patch（幂等）。
function applyPatches(enabled: boolean): void {
  const patchers = [neverAutoSendPatcher, agentSendToolPatcher];
  for (const p of patchers) {
    if (enabled) p.inject();
    else p.revert();
  }
}

// qqbot_send_message 工具定义（在 agent 作用域注册）。
// send 来自 patch 暴露的 snowbotSendMessage 服务。
function createSendMessageTool(send: (content: string, target: string | undefined, exec: unknown) => Promise<{ sent: number; target: string }>) {
  return {
    name: 'qqbot_send_message',
    description: 'Send a text (markdown) message to the QQ user or group of the current conversation. Use this to reply; long content is auto-split into multiple messages.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The message text to send (markdown supported).' },
        target: { type: 'string', description: 'Optional "c2c:openid" or "group:openid". Omit to send to the current conversation.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { sent: { type: 'integer' }, target: { type: 'string' } },
        required: ['sent', 'target'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { content: string; target?: string }, exec: unknown) {
      return send(args?.content, args?.target, exec);
    },
  };
}

export { agentSendToolPatcher, applyPatches, createSendMessageTool, neverAutoSendPatcher };
