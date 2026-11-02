// =====================================================================
//  mcp_linker.ts —— 本机 Tulpa MCP 连接与工具调用
//
//  凭据（bearer）与地址由配置面板（configForm）提供，不再读取任何
//  DSH 连接存储文件。严格限制为 127.0.0.1/localhost HTTP 端点。
//  该模块负责 JSON-RPC 初始化、会话维护、工具调用与响应解析。
// =====================================================================

import type { Transport } from './common/dsh_types.js';

// 只连本机 loopback Tulpa；bearer/url 由调用方（配置面板）提供。
async function connectorTransport(opts: { bearer: string; url?: string }): Promise<Transport> {
  const bearer = opts.bearer?.trim();
  if (!bearer) throw new Error('缺少 Tulpa bearer 配置');
  let url: URL;
  try {
    url = new URL(opts.url?.trim() || 'http://127.0.0.1:18777/mcp');
  } catch {
    throw new Error('Tulpa 地址不合法');
  }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('仅支持本机 loopback Tulpa 端点');
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  let session: string | null = null;
  let protocol = '2025-03-26';
  let seq = 0;

  async function request(method: string, params: unknown, notify = false) {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': protocol },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notify ? { id: ++seq } : {}), method, params }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Tulpa HTTP ${response.status}`); }
    session = response.headers.get('mcp-session-id') ?? session;
    const text = await response.text();
    if (notify && !text.trim()) return {};
    let messages: any[];
    try {
      messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5)))
        : [JSON.parse(text)];
    } catch { throw new Error('Malformed Tulpa protocol response'); }
    const payload = messages.find(x => x.id === seq) ?? messages.at(-1);
    if (payload?.error) throw new Error('Tulpa protocol error');
    return payload?.result ?? {};
  }

  const init = await request('initialize', {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: 'dsh-snow-bot-frame', version: '0.4.0' }
  });
  protocol = init.protocolVersion ?? protocol;
  await request('notifications/initialized', {}, true);

  return {
    serverName: 'tulpa',
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(`Tulpa rejected ${name}`);
      if (result.structuredContent) return result.structuredContent;
      const text = (result.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n');
      try { return JSON.parse(text); } catch { throw new Error(`Tulpa ${name} returned non-JSON`); }
    },
    async close() {
      if (session) {
        const r = await fetch(url, { method: 'DELETE', redirect: 'error', headers: { ...headers, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol }, signal: AbortSignal.timeout(3000) });
        await r.body?.cancel();
      }
    },
  };
}

export { connectorTransport };
