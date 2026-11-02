// =====================================================================
//  config_routes.ts —— 配置面板数据通道（desktop 端专用）
//
//  desktop 端（Electron）没有 configForms 服务（那是 web 端 ui-settings
//  的客户端服务），所以配置面板不能像 web 端那样用 ctx.configForms 读写。
//  这里改走官方 desktop 插件（dsh-qqbot / dsh-desktop-settings）的成熟做法：
//  host 侧在 ctx.webServer 上注册 GET / POST 路由，client 侧用 fetch 相对
//  路径读写，desktop 下由壳的 IPC 桥自动转发到宿主。
//
//  写回目标：profile 的 cordis.patch.yml（覆盖层），用「- id」条目覆盖
//  bundle patch（cordis.patch.yml 的「- insert」条目）里的 config。
//
//  Config Schema 本体见 src/config_schema.ts。
// =====================================================================

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, YAMLMap } from 'yaml';
import type { Ctx } from '../common/dsh_types.js';
import { desktopProfileDir } from './paths.js';

// 插件在 profile 里的条目 id（与 cordis.patch.yml 的 insert id 一致）。
const ENTRY_ID = 'dsh-snow-bot-frame';
const CONFIG_PATH = '/snow-bot/config';

// 配置字段校验（对齐 config_schema.ts 的 Config 字段），非法返回 null。
function validateConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of ['workspace', 'tulpaUrl', 'tulpaBearer'] as const) {
    if (src[key] === undefined) continue;
    if (typeof src[key] !== 'string') return null;
    out[key] = src[key];
  }

  if (src.trimSections !== undefined) {
    if (!Array.isArray(src.trimSections) || src.trimSections.some((s) => typeof s !== 'string')) return null;
    out.trimSections = src.trimSections;
  }

  if (src.toolAllowlist !== undefined) {
    if (!Array.isArray(src.toolAllowlist) || src.toolAllowlist.some((s) => typeof s !== 'string')) return null;
    out.toolAllowlist = src.toolAllowlist;
  }

  if (src.patchEnabled !== undefined) {
    if (typeof src.patchEnabled !== 'boolean') return null;
    out.patchEnabled = src.patchEnabled;
  }

  return out;
}

// 写回 profile 的 cordis.patch.yml：更新/新增 ENTRY_ID 条目的 config，原子写。
function writeProfileConfig(config: Record<string, unknown>): boolean {
  const patchPath = join(desktopProfileDir, 'cordis.patch.yml');
  try {
    const before = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
    const doc: any = parseDocument(before || '[]');
    if (!isSeq(doc.contents)) return false; // 顶层不是数组：fail-closed

    let entry: any = null;
    for (const item of doc.contents.items) {
      if (!isMap(item)) continue;
      const idNode = item.get('id', true);
      if (isScalar(idNode) && String(idNode.value) === ENTRY_ID) { entry = item; break; }
    }

    if (entry === null) {
      entry = new YAMLMap();
      entry.set('id', ENTRY_ID);
      entry.set('config', doc.createNode(config));
      doc.contents.add(entry);
    } else {
      entry.set('config', doc.createNode(config));
    }

    const next = doc.toString({ lineWidth: 0 });
    const tmpPath = `${patchPath}.snowbot.tmp`;
    writeFileSync(tmpPath, next, 'utf8');
    renameSync(tmpPath, patchPath);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: any, status: number, body: Record<string, unknown>) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// 注册 GET/POST /snow-bot/config 路由。getConfig 返回当前生效配置（已解包）。
function registerConfigRoutes(ctx: Ctx, getConfig: () => Record<string, unknown>) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;

    const handler = async (req: any, res: any) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, config: getConfig() });
        return;
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体必须是合法 JSON' });
          return;
        }
        const validated = validateConfig(body);
        if (validated === null) {
          sendJson(res, 400, { ok: false, error: '配置字段类型不合法' });
          return;
        }
        if (!writeProfileConfig(validated)) {
          sendJson(res, 500, { ok: false, error: '写入 cordis.patch.yml 失败' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    };

    const dispose = webServer.register({ kind: 'exact', path: CONFIG_PATH, handler });
    if (typeof scoped.effect === 'function') scoped.effect(() => dispose);
  });
}

export { registerConfigRoutes };
