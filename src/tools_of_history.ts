// =====================================================================
//  tools_of_history.ts —— 群历史消息与上下文查询
//
//  本脚本用于弥补官方 QQ Bot 无法获取聊天历史的短板。
//  使 AI 能读取当前群的近期消息、按条件检索历史、展开指定消息前后文
//  并完整读取长消息，用于补充群聊上下文和理解讨论经过。
// =====================================================================

import { createHash } from 'node:crypto';
import { FAILED_TIPS } from './bridge/qqbot_prefs.js';
import type { McpClient, TulpaMcp } from './bridge/tulpa_mcp.js';
import type { ResolvedGroup } from './group_resolver.js';
import { historyToolPrompts } from './prompt.js';


export interface HistoryMessage {
  id: number;
  timestamp: number;
  platform: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  [k: string]: unknown;
}

class HistoryUtil {
  constructor(
    private t: McpClient,
    private binding: { platform?: string; conversation_id: string; },
  ) {
    if (!binding.conversation_id) throw new Error('Trusted conversation binding required');
  }

  private get platform() { return this.binding.platform ?? 'qq'; }
  private get conversation() { return this.binding.conversation_id; }

  // 校验当前会话在 Tulpa 授权范围内，返回快照游标。
  private async scope(): Promise<number> {
    const s = await this.t.call('get_data_status', {});
    const allowed = s.scope?.conversations?.some((x: string) => {
      try { const a = JSON.parse(x); return a[0] === this.platform && a[1] === this.conversation; }
      catch { return false; }
    });
    if (!allowed || !s.scope?.platforms?.includes(this.platform)) throw new Error('Conversation outside Tulpa authorization');
    return s.snapshot_max_id;
  }

  private async sql(where: string, limit: number, snapshot: number): Promise<[number, number][]> {
    const page = await this.t.call('query_communication_db', {
      sql: `SELECT id,timestamp FROM agent_messages WHERE platform=${quote(this.platform)} AND conversation_id=${quote(this.conversation)} ${where} ORDER BY timestamp DESC,id DESC LIMIT ${limit}`,
      max_rows: limit,
      snapshot_max_id: snapshot,
    });
    if (page.truncated) throw new Error('Query unexpectedly truncated');
    return page.rows ?? [];
  }

  private async get(id: number, snapshot: number): Promise<HistoryMessage> {
    const c = await this.t.call('get_context', { message_id: id, radius: 0, snapshot_max_id: snapshot });
    const m = c.messages?.find((x: any) => x.id === id);
    if (!m || m.platform !== this.platform || m.conversation_id !== this.conversation) throw new Error('Message not in current conversation');
    return { ...m, sources: c.sources ?? [] };
  }

  // 最近消息（时间正序）。cursor = 上一页返回的 next_cursor。
  async recentMessages(args: { limit?: number; cursor?: string; } = {}) {
    return this.searchMessages({ limit: args.limit, cursor: args.cursor });
  }

  // 组合检索（时间正序）。条件 AND；翻页只变 cursor，其余条件不变。
  async searchMessages(args: { start?: string; end?: string; sender?: string; keyword?: string; limit?: number; cursor?: string; } = {}) {
    const { start, end, sender, keyword, cursor } = args;
    const limit = number(args.limit, 10);
    if (!limit) throw new Error('limit must be positive');
    const current = await this.scope();
    const signature = createHash('sha256').update(JSON.stringify([this.platform, this.conversation, start ?? null, end ?? null, sender ?? null, keyword ?? null])).digest('hex');
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
      let c: any;
      try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new Error('Invalid cursor'); }
      if (c.signature !== signature || !Number.isSafeInteger(c.snapshot) || c.snapshot > current || !Number.isSafeInteger(c.time) || !Number.isSafeInteger(c.id)) throw new Error('Cursor scope or query mismatch');
      snapshot = c.snapshot;
      where += ` AND (timestamp<${c.time} OR (timestamp=${c.time} AND id<${c.id}))`;
    }
    const rows = await this.sql(where, limit + 1, snapshot);
    const selected = rows.slice(0, limit); // 最新在前（DESC）
    const messages: HistoryMessage[] = [];
    for (const [id] of selected) messages.push(await this.get(id, snapshot));
    messages.reverse(); // 按时间正序返回
    const oldest = selected.at(-1);
    return {
      messages,
      has_more: rows.length > limit,
      next_cursor: rows.length > limit && oldest ? Buffer.from(JSON.stringify({ signature, snapshot, id: oldest[0], time: oldest[1] })).toString('base64url') : null,
    };
  }

  // 展开某条消息的前后文（时间正序）。
  async messageContext(args: { id: number; before?: number; after?: number; }) {
    const { id } = args;
    const before = number(args.before, 8);
    const after = number(args.after, 8);
    const snapshot = await this.scope();
    await this.get(id, snapshot);
    const r = await this.t.call('get_context', { message_id: id, radius: Math.max(before, after), snapshot_max_id: snapshot });
    const i = r.messages?.findIndex((x: any) => x.id === id);
    if (i === undefined || i < 0) throw new Error('Missing anchor');
    const messages = r.messages.slice(Math.max(0, i - before), i + after + 1);
    if (messages.some((x: any) => x.platform !== this.platform || x.conversation_id !== this.conversation)) throw new Error('Context crossed binding');
    return { messages, id, sources: r.sources?.filter((s: any) => messages.some((m: any) => m.id === s.message_id)) ?? [] };
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
      if (!p.has_more) return { ...message, content: text, truncated: false, snapshot_max_id: snapshot, attachment_note: 'Only imported native text, quote and attachment metadata are available; missing media is not reconstructed.' };
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
) {
  const str = { type: 'string' };
  const int = { type: 'integer' };
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };
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

  return (Object.keys(parameters) as ToolName[]).map(name => ({
    name,
    description: historyToolPrompts[name],
    parameters: parameters[name],
    output,
    async execute(args: any) { return run(name, args); },
  }));
}

const quote = (x: unknown) => `'${String(x).replaceAll("'", "''")}'`;

function number(x: unknown, fallback: number, max = 32): number {
  const v = (x ?? fallback) as number;
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error('Integer parameter out of range');
  return v;
}

function date(x: string | undefined, end = false): number | null {
  if (!x) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(x)) throw new Error('Use Beijing YYYY-MM-DD or YYYY-MM-DD HH:MM');
  const ms = Date.parse(x.replace(' ', 'T') + (x.length === 10 ? 'T00:00:00' : ':00') + '+08:00');
  if (!Number.isFinite(ms)) throw new Error('Invalid date');
  return ms + (end && x.length === 10 ? 86400000 : 0);
}


export { createHistoryTools, HistoryUtil };
