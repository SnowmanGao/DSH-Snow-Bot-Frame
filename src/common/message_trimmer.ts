// =====================================================================
//  message_trimmer.ts —— QQ 聊天记录净化器
//
//  Tulpa MCP 返回的原始消息含大量对 LLM 无用的冗余字段：platform、
//  conversation_id、conversation_type、is_self、sender_id、sources 等，
//  且每条消息重复出现，严重浪费 token。这里把消息瘦身成 LLM 真正需要
//  的精简结构，并把翻页游标 next_cursor 压缩成短 token。
//
//  只做「字段级净化」（保持 JSON、不 reformat 成人类阅读格式）：
//  LLM 解析 JSON 无压力，真正的问题是冗余字段，而非格式。
// =====================================================================

export interface PurifiedMessage {
  id: number;          // 消息 id，供 qqtool_get_message / qqtool_get_message_context 引用
  time: string;        // 去时区后缀，如 "2026-11-05 21:19:23"
  sender: string;      // 发送者昵称（去掉「昵称：」前缀）
  content: string;     // 正文
  truncated?: boolean; // 仅当长消息被折叠时为 true（提示可用 qqtool_get_message 读全文）
  media?: unknown[];   // 仅当含附件/图片等非空时保留
}

// 发送者昵称清洗：去掉 Tulpa 的「昵称：/备注：」展示前缀；空则回退 QQ 号。
function cleanSender(sender: unknown, senderId: unknown): string {
  let s = String(sender ?? '').trim();
  s = s.replace(/^(昵称|备注|名字|姓名)[：:]\s*/, '');
  if (!s) s = String(senderId ?? '').trim();
  return s;
}

// 时间清洗：去掉尾部时区后缀（如 " +08:00"）。
function cleanTime(t: unknown): string {
  return String(t ?? '').trim().replace(/\s*[+-]\d{2}:\d{2}\s*$/, '').trim();
}

// 单条消息净化。
function purifyMessage(m: Record<string, unknown>): PurifiedMessage {
  const out: PurifiedMessage = {
    id: m.id as number,
    time: cleanTime(m.time),
    sender: cleanSender(m.sender, m.sender_id),
    content: String(m.content ?? ''),
  };
  if (m.truncated) out.truncated = true;
  if (Array.isArray(m.media) && m.media.length) out.media = m.media;
  return out;
}

// 消息数组净化。
function purifyMessages(list: unknown[]): PurifiedMessage[] {
  return (list ?? []).map((m) => purifyMessage(m as Record<string, unknown>));
}

// ---- 翻页游标压缩 ----
// 原游标含 64 位防篡改签名（sha256 hex），对 LLM 只是不透明 token 却占大量
// token。签名仅用于「防 LLM 把不同查询的游标串用」，并非安全边界（会话由
// binding 固定、scope() 每次校验授权）。故去掉签名，仅存 [snapshot, id, time]
// 三元组并紧凑编码，长度从 ~150 字符降到 ~40 字符。

function encodeCursor(snapshot: number, id: number, time: number): string {
  return Buffer.from(JSON.stringify([snapshot, id, time])).toString('base64url');
}

function decodeCursor(cursor: string): { snapshot: number; id: number; time: number } {
  let arr: unknown;
  try {
    arr = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw new Error('Invalid cursor');
  }
  if (!Array.isArray(arr) || arr.length !== 3) throw new Error('Invalid cursor');
  const [snapshot, id, time] = arr as [unknown, unknown, unknown];
  if (!Number.isSafeInteger(snapshot) || !Number.isSafeInteger(id) || !Number.isSafeInteger(time)) {
    throw new Error('Invalid cursor');
  }
  return { snapshot: snapshot as number, id: id as number, time: time as number };
}

export { cleanSender, cleanTime, decodeCursor, encodeCursor, purifyMessage, purifyMessages };
