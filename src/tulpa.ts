// =====================================================================
//  tulpa.ts —— 本机 Tulpa 查询客户端（群清单 + 消息指纹匹配）
//
//  数据源是 Tulpa 的 MCP 只读工具（list_conversations / read_conversation），
//  这些工具直接查源库、无全量投影，适合高频/即时调用。
//
//  「消息指纹配对」：QQ 机器人收到的群消息，靠「发送时间戳 + 内容」在
//  Tulpa 里唯一匹配出所属群（openid ↔ 群号 之间没有官方直连，只能这样桥）。
// =====================================================================

import { connectorTransport } from './mcp_linker.js';
import type { Transport } from './common/dsh_types.js';

export interface TulpaConversation {
  conversationId: string; // 1870893282:group:712941409
  groupId: string;        // 712941409
  groupName: string;      // 未来⌬使徒⌬研究㍿
}

// 匹配时间窗口（毫秒）：容忍 QQ 消息发送 → Tulpa 入库的延迟与时钟偏差。
const MATCH_WINDOW = 180_000;
// 内容过短（≤1 字）不参与匹配，避免误命中。
const MIN_CONTENT_LEN = 2;

// 群号从 conversation_id 提取：<账号>:group:<群号>
function parseGroupId(conversationId: string): string | undefined {
  const m = /:group:(\d+)$/.exec(conversationId);
  return m ? m[1] : undefined;
}

// Tulpa 返回的 time 是北京时间字符串 "YYYY-MM-DD HH:MM:SS +08:00"（无原始毫秒）。
// 转回 Unix 毫秒（UTC）以便与 DSH 侧的时间戳比较。
function beijingTimeToMs(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
}

// 打开一个 Tulpa 连接并执行回调，最后自动关闭。
async function withTulpa<T>(bearer: string, url: string | undefined, fn: (t: Transport) => Promise<T>): Promise<T> {
  const t = await connectorTransport({ bearer, url });
  try {
    return await fn(t);
  } finally {
    await t.close().catch(() => { });
  }
}

// 从 list_conversations 返回页里解析出 QQ 群清单（按群号去重）。
function parseGroups(page: any): TulpaConversation[] {
  const out: TulpaConversation[] = [];
  const seen = new Set<string>();
  for (const c of page.conversations ?? []) {
    if (c.conversation_type !== 'group') continue;
    const conversationId = String(c.conversation_id ?? '');
    const groupId = parseGroupId(conversationId);
    if (!groupId || seen.has(groupId)) continue;
    seen.add(groupId);
    out.push({ conversationId, groupId, groupName: String(c.conversation ?? '').trim() || groupId });
  }
  return out;
}

// 已授权的 QQ 群清单（含群名），按群号去重。
async function listGroups(bearer: string, url: string | undefined): Promise<TulpaConversation[]> {
  return withTulpa(bearer, url, async (t) => {
    const page = await t.call('list_conversations', { platform: 'qq', limit: 20 });
    return parseGroups(page);
  });
}

// 消息指纹匹配：在时间窗口内，找「内容出现在 agentBody 里」的群，唯一才采信。
async function matchGroup(bearer: string, url: string | undefined, agentBody: string, now: number): Promise<TulpaConversation | undefined> {
  // 单连接完成「列群 + 逐群读最新消息」，避免为每个群重复建连。
  return withTulpa(bearer, url, async (t) => {
    const page = await t.call('list_conversations', { platform: 'qq', limit: 20 });
    const groups = parseGroups(page);
    const hits: TulpaConversation[] = [];
    for (const g of groups) {
      let rp: any;
      try {
        rp = await t.call('read_conversation', { platform: 'qq', conversation_id: g.conversationId, order: 'newest', limit: 5 });
      } catch {
        continue; // 单群读取失败不影响其它群
      }
      for (const m of rp.messages ?? []) {
        const content = String(m.content ?? '').trim();
        if (content.length < MIN_CONTENT_LEN) continue;
        const ts = beijingTimeToMs(String(m.time ?? ''));
        if (ts === undefined || Math.abs(ts - now) > MATCH_WINDOW) continue;
        if (agentBody.includes(content)) { hits.push(g); break; }
      }
    }
    // 命中多个群则视为歧义，不采信（下条消息再学）。
    return hits.length === 1 ? hits[0] : undefined;
  });
}

export { listGroups, matchGroup };
