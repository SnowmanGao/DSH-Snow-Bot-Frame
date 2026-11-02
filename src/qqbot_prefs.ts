// =====================================================================
//  qqbot_prefs.ts —— 读取官方 dsh-qqbot 的会话偏好（openid ↔ 对话ID）
//
//  dsh-qqbot 把 sessionKey `qqbot:<appId>:group:<groupOpenid>` → sessionId
//  的映射持久化在 ~/.dsh-qqbot/model-prefs.json（resume/create 会话后落盘）。
//  本模块带 mtime 缓存动态读取，并提供 sessionId → openid 反向查找，
//  用于在 session/event 里识别「当前会话属于哪个 QQ 群」。
// =====================================================================

import { readFileSync, statSync } from 'node:fs';
import { qqbotPrefs } from './path.js';

let cachedMtime = 0;
let cachedMap = new Map<string, string>(); // openid → sessionId（仅群聊）

// 全量读取 openid → sessionId（mtime 变化才重新解析，失败沿用上次缓存）。
function sessionIdsByOpenid(): Map<string, string> {
  try {
    const mtime = statSync(qqbotPrefs).mtimeMs;
    if (mtime === cachedMtime) return cachedMap;
    const data = JSON.parse(readFileSync(qqbotPrefs, 'utf8'));
    const map = new Map<string, string>();
    for (const [key, sessionId] of Object.entries(data?.sessionIds ?? {})) {
      if (typeof sessionId !== 'string' || !sessionId) continue;
      // sessionKey 形如 qqbot:<appId>:group:<openid>（群聊）；c2c 条目不含 ':group:'，跳过
      const i = key.indexOf(':group:');
      if (i >= 0) map.set(key.slice(i + ':group:'.length), sessionId);
    }
    cachedMtime = mtime;
    cachedMap = map;
  } catch { /* 文件缺失/损坏时沿用上次缓存 */ }
  return cachedMap;
}

// 按会话 ID 反向查群 openid（非群聊会话返回 undefined）。
function openidForSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  for (const [openid, sid] of sessionIdsByOpenid()) {
    if (sid === sessionId) return openid;
  }
  return undefined;
}

export { openidForSessionId };
