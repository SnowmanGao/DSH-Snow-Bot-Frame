// =====================================================================
//  tulpa_conversation.ts —— Tulpa 会话访问基类
//
//  HistoryUtil（历史查询）与 MediaUtil（媒体获取）共享的会话原语：
//  授权校验（scope）与单条消息抓取（get）。两者都围绕「当前绑定会话」
//  读写 Tulpa 数据，抽出基类避免重复实现。
// =====================================================================

import type { McpClient } from './tulpa_mcp.js';

// Tulpa 原始消息（字段随 Tulpa 版本可能有出入，只声明用到的关键字段）。
export type RawMessage = {
  id: number;
  time?: string;
  sender?: string;
  sender_id?: string;
  content?: string;
  platform?: string;
  conversation_id?: string;
  truncated?: boolean;
  media?: unknown[];
  voice?: Record<string, unknown>;
  reply_to?: { sender?: string; content?: string; };
  [k: string]: unknown;
};

export class TulpaConversation {
  constructor(
    protected t: McpClient,
    protected binding: { platform?: string; conversation_id: string; },
  ) {
    if (!binding.conversation_id) throw new Error('Trusted conversation binding required');
  }

  protected get platform() { return this.binding.platform ?? 'qq'; }
  protected get conversation() { return this.binding.conversation_id; }

  // 校验当前会话在 Tulpa 授权范围内，返回快照游标。
  protected async scope(): Promise<number> {
    const s = await this.t.call('get_data_status', {});
    const allowed = s.scope?.conversations?.some((x: string) => {
      try { const a = JSON.parse(x); return a[0] === this.platform && a[1] === this.conversation; }
      catch { return false; }
    });
    if (!allowed || !s.scope?.platforms?.includes(this.platform)) throw new Error('Conversation outside Tulpa authorization');
    return s.snapshot_max_id;
  }

  // 抓取单条消息（get_context radius=0），并校验属于当前会话。
  protected async get(id: number, snapshot: number): Promise<RawMessage> {
    const c = await this.t.call('get_context', { message_id: id, radius: 0, snapshot_max_id: snapshot });
    const m = c.messages?.find((x: any) => x.id === id) as RawMessage | undefined;
    if (!m || m.platform !== this.platform || m.conversation_id !== this.conversation) throw new Error('Message not in current conversation');
    return m;
  }
}
