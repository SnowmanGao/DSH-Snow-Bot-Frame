// =====================================================================
//  tools_of_history.ts —— 群历史消息与上下文查询
//
//  本脚本用于弥补官方 QQ Bot 无法获取聊天历史的短板。
//  使 AI 能读取当前群的近期消息、按条件检索历史、展开指定消息前后文
//  并完整读取长消息，用于补充群聊上下文和理解讨论经过。
//  媒体（图片下载、语音转写）已拆到 tools_of_media.ts。
// =====================================================================

import { FAILED_TIPS } from './bridge/qqbot_prefs.js';
import type { McpClient, TulpaMcp } from './bridge/tulpa_mcp.js';
import type { ResolvedGroup } from './group_resolver.js';
import { toolPrompts } from './prompt.js';
import { hydrateParameters, type ParamDef } from './common/tools_def_utils.js';
import type { ToolDef } from './common/dsh_types.js';
import { decodeCursor, encodeCursor, purifyMessage, purifyMessages } from './common/message_purifier.js';
import { TulpaConversation, type RawMessage } from './bridge/tulpa_conversation.js';


class HistoryUtil extends TulpaConversation {
  constructor(
    t: McpClient,
    binding: { platform?: string; conversation_id: string; },
  ) {
    super(t, binding);
  }

  private async sql(where: string, limit: number, snapshot: number, order: 'ASC' | 'DESC'): Promise<[number, number][]> {
    const page = await this.t.call('query_communication_db', {
      sql: `SELECT id,timestamp FROM agent_messages WHERE platform=${quote(this.platform)} AND conversation_id=${quote(this.conversation)} ${where} ORDER BY timestamp ${order},id ${order} LIMIT ${limit}`,
      max_rows: limit,
      snapshot_max_id: snapshot,
    });
    if (page.truncated) throw new Error('Query unexpectedly truncated');
    return page.rows ?? [];
  }

  // 最近消息（时间正序）。cursor = 上一页返回的 next_cursor。
  async recentMessages(args: { limit?: number; cursor?: string; } = {}) {
    return this.searchMessages({ limit: args.limit, cursor: args.cursor });
  }

  // 组合检索（本页结果始终按时间从旧到新排列）。条件 AND；翻页只变 cursor，其余条件不变。
  // sort 控制取数方向：latest 取最新匹配（DESC，cursor 沿更早方向），oldest 取最早匹配（ASC，cursor 沿更晚方向）。
  async searchMessages(args: { start?: string; end?: string; sender?: string; keyword?: string; sort?: string; limit?: number; cursor?: string; } = {}) {
    const { start, end, sender, keyword, cursor } = args;
    const sort = args.sort ?? 'latest';
    if (sort !== 'latest' && sort !== 'oldest') throw new Error("sort must be 'latest' or 'oldest'");
    const limit = number(args.limit, 16);
    if (!limit) throw new Error('limit must be positive');
    const current = await this.scope();
    let snapshot = current;
    let where = '';
    const a = date(start), b = date(end, true);
    if (a !== null) where += ` AND timestamp>=${a}`;
    if (b !== null) where += ` AND timestamp<${b}`;
    if (a !== null && b !== null && a >= b) throw new Error('Invalid date range');
    if (sender) {
      let id = sender;
      if (!/^\d+$/.test(sender)) {
        const p = await this.t.call('find_people', { query: sender, platform: this.platform, conversation_id: this.conversation, limit: 10 });
        const ids = [...new Set((p.people ?? p.persons ?? p.matches ?? []).map((x: any) => x.sender_id))] as string[];
        if (p.has_more || ids.length !== 1) throw new Error('Sender ambiguous or missing; use exact account ID');
        id = ids[0];
      }
      where += ` AND sender_id=${quote(id)}`;
    }
    if (keyword) where += ` AND instr(content,${quote(keyword)})>0`;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (c.snapshot > current) throw new Error('Cursor snapshot ahead of data');
      snapshot = c.snapshot;
      const op = sort === 'oldest' ? '>' : '<';
      where += ` AND (timestamp${op}${c.time} OR (timestamp=${c.time} AND id${op}${c.id}))`;
    }
    const order = sort === 'oldest' ? 'ASC' : 'DESC';
    const rows = await this.sql(where, limit + 1, snapshot, order);
    const selected = rows.slice(0, limit); // 沿取数方向的前 limit 条
    const raw: RawMessage[] = [];
    for (const [id] of selected) raw.push(await this.get(id, snapshot));
    if (sort === 'latest') raw.reverse(); // DESC 最新在前，反转为时间正序；ASC 本身已正序
    const boundary = selected.at(-1); // 当前页沿取数方向的最后一条，作为下一页起点
    return {
      messages: purifyMessages(raw),
      has_more: rows.length > limit,
      next_cursor: rows.length > limit && boundary ? encodeCursor(snapshot, boundary[0], boundary[1]) : null,
    };
  }

  // 展开某条消息的前后文（时间正序）。
  async messageContext(args: { id: number; before?: number; after?: number; }) {
    const { id } = args;
    const before = number(args.before, 16);
    const after = number(args.after, 16);
    const snapshot = await this.scope();
    await this.get(id, snapshot);
    const r = await this.t.call('get_context', { message_id: id, radius: Math.max(before, after), snapshot_max_id: snapshot });
    const i = r.messages?.findIndex((x: any) => x.id === id);
    if (i === undefined || i < 0) throw new Error('Missing anchor');
    const messages = r.messages.slice(Math.max(0, i - before), i + after + 1);
    if (messages.some((x: any) => x.platform !== this.platform || x.conversation_id !== this.conversation)) throw new Error('Context crossed binding');
    return { messages: purifyMessages(messages), id };
  }

  // 完整读取单条消息，展开折叠长文本。
  async readMessage(args: { id: number; }) {
    const { id } = args;
    const snapshot = await this.scope();
    const message = await this.get(id, snapshot);
    let text = '';
    let offset = 0;
    for (let i = 0; i < 128; i++) {
      const p = await this.t.call('read_message', { message_id: id, offset, limit: 8000 });
      text += p.content ?? '';
      if (!p.has_more) {
        return {
          ...purifyMessage({ ...message, content: text, truncated: false }),
          attachment_note: 'Only imported native text, quote and attachment metadata are available; missing media is not reconstructed.',
        };
      }
      if (!(p.next_offset > offset)) throw new Error('Non-progressing long-message cursor');
      offset = p.next_offset;
    }
    throw new Error('Message exceeds expansion budget');
  }
}

// 4 个历史工具的完整定义：从 openid 解析所属群，走 Tulpa 读本群历史。
// openid 由调用方以 getOpenid() 懒解析（agent 创建时 prefs 可能尚未落盘）。
function createHistoryTools(
  mcp: TulpaMcp,
  getOpenid: () => string | undefined,
  resolveGroup: (openid: string) => Promise<ResolvedGroup | undefined>,
): ToolDef[] {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };
  const names = ['qqtool_get_recent_messages', 'qqtool_search_messages', 'qqtool_get_message_context', 'qqtool_get_message'] as const;
  type ToolName = typeof names[number];

  // 参数结构（type/required）：真正的类型信息在此，prompt.ts 只放描述文案。
  const paramDefs: Record<ToolName, Record<string, ParamDef>> = {
    qqtool_get_recent_messages: { limit: { type: 'integer' }, cursor: { type: 'string' } },
    qqtool_search_messages: {
      start: { type: 'string' }, end: { type: 'string' }, sender: { type: 'string' },
      keyword: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'integer' }, cursor: { type: 'string' },
    },
    qqtool_get_message_context: { id: { type: 'integer', required: true }, before: { type: 'integer' }, after: { type: 'integer' } },
    qqtool_get_message: { id: { type: 'integer', required: true } },
  };

  const run = async (name: ToolName, args: any) => {
    const openid = getOpenid();
    if (!openid) throw new Error(FAILED_TIPS);
    const group = await resolveGroup(openid);
    if (!group) throw new Error(FAILED_TIPS);
    const binding = { platform: 'qq', conversation_id: group.conversationId };
    // 每操作一连接：mcp.use 负责握手与关闭。
    return mcp.use(async (t) => {
      const h = new HistoryUtil(t, binding);
      switch (name) {
        case 'qqtool_get_recent_messages': return await h.recentMessages(args);
        case 'qqtool_search_messages': return await h.searchMessages(args);
        case 'qqtool_get_message_context': return await h.messageContext(args);
        case 'qqtool_get_message': return await h.readMessage(args);
      }
    });
  };

  return names.map(name => ({
    name,
    description: toolPrompts[name].description,
    parameters: hydrateParameters(toolPrompts[name].parameters, paramDefs[name]),
    output,
    async execute(args: any) { return run(name, args); },
  }));
}

const quote = (x: unknown) => `'${String(x).replaceAll("'", "''")}'`;

function number(x: unknown, fallback: number, max = 64): number {
  const v = (x ?? fallback) as number;
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error('Integer parameter out of range');
  return v;
}

function date(x: string | undefined, end = false): number | null {
  if (!x) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(x))
    throw new Error('Use Beijing YYYY-MM-DD, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS');
  // 纯日期补 T00:00:00，HH:MM 补 :00，HH:MM:SS 直接替换空格为 T。
  const iso = x.length === 10 ? `${x}T00:00:00` : x.length === 16 ? `${x.replace(' ', 'T')}:00` : x.replace(' ', 'T');
  const ms = Date.parse(iso + '+08:00');
  if (!Number.isFinite(ms)) throw new Error('Invalid date');
  return ms + (end && x.length === 10 ? 86400000 : 0);
}


export { createHistoryTools, HistoryUtil };
