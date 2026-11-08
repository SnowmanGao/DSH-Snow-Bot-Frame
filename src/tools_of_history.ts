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

  private async sql(where: string, limit: number, snapshot: number, order: 'ASC' | 'DESC'): Promise<SqlRow[]> {
    const page = await this.t.call('query_communication_db', {
      sql: `SELECT id,timestamp,sender_id,sender,content,platform,conversation_id,has_media,has_voice,has_file FROM agent_messages WHERE platform=${quote(this.platform)} AND conversation_id=${quote(this.conversation)} ${where} ORDER BY timestamp ${order},id ${order} LIMIT ${limit}`,
      max_rows: limit,
      snapshot_max_id: snapshot,
    });
    if (page.truncated) throw new Error('Query unexpectedly truncated');
    return (page.rows ?? []).map((r: any[]) => toSqlRow(r));
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
    const limit = number(args.limit, 8, 32);
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
    // 正文与发送者已随 SQL 一次取回，无需再逐条 get_context：
    // 原「每页 N 条消息 → N 次 get_context」会在 limit 拉满时一次性发出几十次
    // 请求，触发 Tulpa 限流（isError → "Tulpa rejected get_context"）。
    const raw = selected.map(sqlRowToRaw);
    if (sort === 'latest') raw.reverse(); // DESC 最新在前，反转为时间正序；ASC 本身已正序
    const boundary = selected.at(-1); // 当前页沿取数方向的最后一条，作为下一页起点
    return {
      messages: purifyMessages(raw),
      has_more: rows.length > limit,
      next_cursor: rows.length > limit && boundary ? encodeCursor(snapshot, boundary.id, boundary.timestamp) : null,
    };
  }

  // 展开某条消息的前后文（时间正序）。
  // 注意：Tulpa 的 get_context radius 上限是 8（0~8），这里把 before/after 收敛到 8 内，
  // 避免 radius 超限被 Tulpa 拒绝（isError → "Tulpa rejected get_context"）。
  async messageContext(args: { id: number; before?: number; after?: number; }) {
    const { id } = args;
    const before = number(args.before, 8, 8);
    const after = number(args.after, 8, 8);
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

// ---- 从 SQL 行直接构建消息（避免逐条 get_context 触发 Tulpa 限流） ----

// agent_messages 表可直接读出的列（SELECT 顺序固定，见 sql()）。
interface SqlRow {
  id: number;
  timestamp: number;
  sender_id: string;
  sender: string;
  content: string;
  platform: string;
  conversation_id: string;
  has_media: boolean;
  has_voice: boolean;
  has_file: boolean;
}

// 与 get_context 的正文折叠长度保持一致：超过该长度的正文在列表里折叠，
// 由 qqtool_get_message 展开全文（省 token）。
const CONTENT_FOLD = 2000;

// 毫秒时间戳 → 北京时间字符串（无时区后缀，匹配 cleanTime 的约定）。
function formatBeijingTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function toSqlRow(r: any[]): SqlRow {
  return {
    id: Number(r[0]),
    timestamp: Number(r[1]),
    sender_id: String(r[2] ?? ''),
    sender: String(r[3] ?? ''),
    content: String(r[4] ?? ''),
    platform: String(r[5] ?? ''),
    conversation_id: String(r[6] ?? ''),
    has_media: Number(r[7]) === 1,
    has_voice: Number(r[8]) === 1,
    has_file: Number(r[9]) === 1,
  };
}

// SQL 行 → RawMessage（再交给 purifyMessage 收敛成精简结构）。
// 媒体元数据（kind/index）不在 agent_messages 表里，这里按 has_media/has_file
// 给一个粗粒度提示（index 恒为 0）；模型需要精确 kind / 多图 index 时可用
// qqtool_get_message 读完整元数据。语音消息 content 为 [语音消息] 占位，无需 media 提示。
function sqlRowToRaw(row: SqlRow): RawMessage {
  const full = row.content;
  const truncated = full.length > CONTENT_FOLD;
  const media: unknown[] = [];
  if (row.has_file) media.push({ kind: 'file', index: 0 });
  else if (row.has_media) media.push({ kind: 'image', index: 0 });
  return {
    id: row.id,
    time: formatBeijingTime(row.timestamp),
    sender: row.sender,
    sender_id: row.sender_id,
    content: truncated ? full.slice(0, CONTENT_FOLD) : full,
    ...(truncated ? { truncated: true } : {}),
    ...(media.length ? { media } : {}),
    platform: row.platform,
    conversation_id: row.conversation_id,
  };
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
