// =====================================================================
//  tools_of_chat.ts —— 用于赋予 AI 自由发送消息的能力
// 
//  本脚本用于阻止 QQ Bot 插件将 Assistant 文本自动发送到 QQ，并把
//  发送 QQ 消息时机的控制权彻底交给 AI。
//
//  ！通过修改文件、注入插件源代码实现，需重启 DSH 生效。
//  ！仅适配 @tencent-connect/dsh-qqbot@0.5.5，破坏性更新会导致失效。
// =====================================================================

import { SourcePatcher } from './common/source_patcher.js';
import { qqBotOutbound, qqBotBootstrap } from './path.js';

// 1. 抑制自动发送：在 route() 里丢弃自动输出事件。
// 参见 dsh-qqbot@0.5.5 outbound.js 的 route 函数。
const NeverAutoSendPatcher = new SourcePatcher({
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

// 2. 注入文本发送工具：在 registerSendFileTool 之后注册 qqbot_send_message。
// 复用同一作用域内的 sender（sendMarkdown，含被动回复限额兜底）、manager（findByAgent 定位回复目标）、config（textChunkLimit 分块阈值）。
const AgentSendToolPatcher = new SourcePatcher({
  file: qqBotBootstrap,
  before: '    registerSendFileTool(ctx, mediaSender, manager, config, logger);',
  after: `    registerSendFileTool(ctx, mediaSender, manager, config, logger);
    // ── 文本发送工具（qqbot_send_message，dsh-snow-bot-frame 注入：显式输出架构） ──
    const snowTools = ctx.get('tools');
    if (snowTools?.register) {
      const snowParseTarget = (input) => {
        const idx = input.indexOf(':');
        if (idx <= 0) return undefined;
        const scope = input.slice(0, idx);
        const targetId = input.slice(idx + 1);
        if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
        return { scope, targetId };
      };
      snowTools.register({
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
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const { content, target } = args;
          if (typeof content !== 'string' || content.trim().length === 0) {
            throw new Error('qqbot_send_message: \`content\` must be a non-empty string');
          }
          let replyTarget;
          if (target !== undefined && target !== '') {
            replyTarget = snowParseTarget(target);
            if (replyTarget === undefined) throw new Error(\`qqbot_send_message: target 格式错误，需要 c2c:openid 或 group:openid，收到: \${target}\`);
          }
          else if (exec.agent !== undefined) {
            replyTarget = manager.findByAgent(exec.agent)?.replyTarget;
          }
          if (replyTarget === undefined) {
            throw new Error('qqbot_send_message: 无法确定发送目标，请显式传 target 参数');
          }
          const { chunkMarkdownText } = await import('../transport/chunker.js');
          const chunks = chunkMarkdownText(content, config.textChunkLimit);
          for (const chunk of chunks) {
            await sender.sendMarkdown(replyTarget, chunk);
          }
          logger.info(\`[snow-bot] qqbot_send_message 发送 \${chunks.length} 条 → \${replyTarget.scope}:\${replyTarget.targetId}\`);
          return { sent: chunks.length, target: \`\${replyTarget.scope}:\${replyTarget.targetId}\` };
        },
      });
      logger.info('[snow-bot] qqbot_send_message 工具已注册');
    }`,
});

export { NeverAutoSendPatcher, AgentSendToolPatcher };
