// =====================================================================
//  bridge/tulpa.ts —— Tulpa 领域查询（群清单 + 消息指纹匹配）
//
//  数据源是 Tulpa 的 MCP 只读工具（list_conversations / read_conversation），
//  这些工具直接查源库、无全量投影，适合高频即时调用。
//
//  「消息指纹配对」：QQ 机器人收到的群消息，靠「发送时间戳 + 内容」在
//  Tulpa 里唯一匹配出所属群（openid ↔ 群号 之间没有官方直连，只能这样桥）。
//
//  连接由注入的 TulpaMcp 实例管理（每操作一连接），本模块只写查询逻辑。
// =====================================================================

import type { TulpaMcp } from './tulpa_mcp.js';

export interface TulpaConversation {
  conversationId: string; // 1870893282:group:712941409
  groupId: string;        // 712941409
  groupName: string;      // 群名称
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

// 从 im-qqbot 组装后的 agentBody 里提取「用户实际输入的核心文本」。
// agentBody 形如 `[昵称 (openid)] 内容 (@you)`，群聊还可能带历史/引用/
// 媒体块；Tulpa 里存的是原始消息（可能含 `@机器人昵称` 前缀）。这里只取
// 核心内容，再与 Tulpa 消息做「互相包含」匹配。
function extractCore(agentBody: string): string {
  let t = agentBody;
  // 群聊历史块 [Chat history begins]…[Chat history ends]
  t = t.replace(/\[Chat history begins\][\s\S]*?\[Chat history ends\]/g, '');
  // 引用块 [Quoted message begins]…[Quoted message ends]
  t = t.replace(/\[Quoted message begins\][\s\S]*?\[Quoted message ends\]/g, '');
  // [Current message] 标记
  t = t.replace(/\[Current message\]/g, '');
  // 媒体附件标签
  t = t.replace(/\[(?:图片|视频|文件)\]/g, '');
  t = t.replace(/\[Voice message[^\]]*\]/g, '');
  // 动态媒体行（- Image: … / - ASR: … 等）
  t = t.replace(/^\s*-[^\n]*\n?/gm, '');
  // 行首发送者标签 [昵称 (openid)]
  t = t.replace(/^\s*\[[^\]]*\]\s*/, '');
  // 末尾 (@you) 标记
  t = t.replace(/\s*\(@you\)\s*$/, '');
  return t.trim();
}

// Tulpa 返回的 time 是北京时间字符串 "YYYY-MM-DD HH:MM:SS +08:00"（无原始毫秒）。
// 转回 Unix 毫秒（UTC）以便与 DSH 侧的时间戳比较。
function beijingTimeToMs(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
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
function listGroups(mcp: TulpaMcp): Promise<TulpaConversation[]> {
  return mcp.use(async (t) => {
    const page = await t.call('list_conversations', { platform: 'qq', limit: 20 });
    return parseGroups(page);
  });
}

// 消息指纹匹配：在时间窗口内，找「内容与核心文本互相包含」的群，唯一才采信。
function matchGroup(mcp: TulpaMcp, agentBody: string, now: number): Promise<TulpaConversation | undefined> {
  // 先提取核心文本；过短则放弃匹配（避免「嗯」「好」等误命中多个群）。
  const core = extractCore(agentBody);
  if (core.length < MIN_CONTENT_LEN) return Promise.resolve(undefined);

  // 单连接完成「列群 + 逐群读最新消息」，避免为每个群重复建连。
  return mcp.use(async (t) => {
    const page = await t.call('list_conversations', { platform: 'qq', limit: 20 });
    const groups = parseGroups(page);
    const hits: TulpaConversation[] = [];
    for (const g of groups) {
      let rp: any;
      try {
        rp = await t.call('read_conversation', { platform: 'qq', conversation_id: g.conversationId, order: 'newest', limit: 10 });
      } catch {
        continue; // 单群读取失败不影响其它群
      }
      for (const m of rp.messages ?? []) {
        const content = String(m.content ?? '').trim();
        if (content.length < MIN_CONTENT_LEN) continue;
        const ts = beijingTimeToMs(String(m.time ?? ''));
        if (ts === undefined || Math.abs(ts - now) > MATCH_WINDOW) continue;
        // 双向包含：Tulpa 原始消息可能含 @机器人昵称 前缀，agentBody 核心是去掉标签后的正文
        if (content.includes(core) || core.includes(content)) { hits.push(g); break; }
      }
    }
    // 命中多个群则视为歧义，不采信（下条消息再学）。
    return hits.length === 1 ? hits[0] : undefined;
  });
}

export { extractCore, listGroups, matchGroup };
