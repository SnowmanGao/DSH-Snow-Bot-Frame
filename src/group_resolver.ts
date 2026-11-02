// =====================================================================
//  group_resolver.ts —— openid → 群 的自动解析器（学习 + 缓存 + 落盘）
//
//  零手填：openid 与群号之间没有官方直连，靠「最近一条消息的时间戳 +
//  内容」去 Tulpa 配对，成功后把 openid → 群 落盘（~/.dsh-snow-bot-frame/
//  learned-groups.json），之后永久命中缓存，无需再次查询。
//
//  结构：GroupResolver 实例持有每个 bearer/url 的运行时状态（待学习队列、
//  最近消息、群名缓存）；learned-groups.json 的文件缓存是跨实例共享的
//  模块级状态，保持为模块函数。
// =====================================================================

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { learnedGroupsFile } from './bridge/paths.js';
import { listGroups, matchGroup } from './bridge/tulpa.js';
import type { TulpaMcp } from './bridge/tulpa_mcp.js';

export interface ResolvedGroup {
  conversationId: string;
  groupId: string;
  groupName: string;
}

interface LearnedEntry {
  conversationId: string;
  groupId: string;
  groupName: string;
  learnedAt: number;
}

// ---- 持久化：openid → 群（mtime 缓存，写时原子替换；跨实例共享） ----
let cachedMtime = 0;
let cachedMap = new Map<string, LearnedEntry>();

function loadLearned(): Map<string, LearnedEntry> {
  try {
    const mtime = statSync(learnedGroupsFile).mtimeMs;
    if (mtime === cachedMtime) return cachedMap;
    const data = JSON.parse(readFileSync(learnedGroupsFile, 'utf8'));
    const map = new Map<string, LearnedEntry>();
    for (const [openid, e] of Object.entries(data?.groups ?? {})) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      if (typeof rec.conversationId !== 'string' || typeof rec.groupId !== 'string') continue;
      map.set(openid, {
        conversationId: rec.conversationId,
        groupId: rec.groupId,
        groupName: typeof rec.groupName === 'string' && rec.groupName ? rec.groupName : rec.groupId,
        learnedAt: typeof rec.learnedAt === 'number' ? rec.learnedAt : 0,
      });
    }
    cachedMtime = mtime;
    cachedMap = map;
  } catch { /* 文件缺失/损坏时沿用上次缓存 */ }
  return cachedMap;
}

function persistLearned() {
  try {
    mkdirSync(dirname(learnedGroupsFile), { recursive: true });
    const payload = { groups: Object.fromEntries(cachedMap) };
    const tmp = `${learnedGroupsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, learnedGroupsFile);
    cachedMtime = statSync(learnedGroupsFile).mtimeMs;
  } catch { /* 写失败不致命，下条消息会重新学习 */ }
}

// ---- 运行时解析器（每个 TulpaMcp 连接配置一个实例） ----
class GroupResolver {
  private mcp: TulpaMcp;

  // 待学习/学习中的 openid（去重并发）
  private pending = new Map<string, Promise<ResolvedGroup | undefined>>();
  // openid 最近一条消息（学习素材）
  private latestMessage = new Map<string, { text: string; time: number }>();
  // 群名缓存（groupId → groupName），后台刷新
  private nameCache = new Map<string, string>();
  private namesFetchedAt = 0;
  private refreshing = false;

  constructor(mcp: TulpaMcp) {
    this.mcp = mcp;
  }

  private async refreshNames() {
    if (this.refreshing || Date.now() - this.namesFetchedAt < 5 * 60_000) return;
    this.refreshing = true;
    try {
      const groups = await listGroups(this.mcp);
      const m = new Map<string, string>();
      for (const g of groups) m.set(g.groupId, g.groupName);
      this.nameCache = m;
      this.namesFetchedAt = Date.now();
    } catch { /* 忽略，沿用旧缓存 */ }
    finally { this.refreshing = false; }
  }

  private displayName(groupId: string, fallback: string): string {
    return this.nameCache.get(groupId) ?? fallback;
  }

  // 已知群（已学习）直接返回。
  private known(openid: string): ResolvedGroup | undefined {
    const e = loadLearned().get(openid);
    if (!e) return undefined;
    return { conversationId: e.conversationId, groupId: e.groupId, groupName: this.displayName(e.groupId, e.groupName) };
  }

  // 学习：用最近一条消息去 Tulpa 配对，成功后落盘。
  private async learn(openid: string, text: string, time: number): Promise<ResolvedGroup | undefined> {
    const hit = await matchGroup(this.mcp, text, time);
    if (!hit) return undefined;
    loadLearned().set(openid, { conversationId: hit.conversationId, groupId: hit.groupId, groupName: hit.groupName, learnedAt: Date.now() });
    persistLearned();
    this.nameCache.set(hit.groupId, hit.groupName);
    return { conversationId: hit.conversationId, groupId: hit.groupId, groupName: hit.groupName };
  }

  // 解析：缓存命中即返回；miss 时用最近一条消息学习（并发去重）。
  resolve(openid: string): Promise<ResolvedGroup | undefined> {
    const k = this.known(openid);
    if (k) return Promise.resolve(k);
    const inFlight = this.pending.get(openid);
    if (inFlight) return inFlight;
    const latest = this.latestMessage.get(openid);
    if (!latest) return Promise.resolve(undefined);
    const p = this.learn(openid, latest.text, latest.time).finally(() => this.pending.delete(openid));
    this.pending.set(openid, p);
    return p;
  }

  // 记录 openid 最近一条消息（供学习用），并顺手触发群名后台刷新。
  noteMessage(openid: string, text: string, time: number) {
    this.latestMessage.set(openid, { text, time });
    void this.refreshNames();
  }

  // 面板展示：已自动学习的群映射。
  listLearned(): { openid: string; groupId: string; groupName: string }[] {
    return [...loadLearned()].map(([openid, e]) => ({ openid, groupId: e.groupId, groupName: this.displayName(e.groupId, e.groupName) }));
  }
}

export { GroupResolver };
