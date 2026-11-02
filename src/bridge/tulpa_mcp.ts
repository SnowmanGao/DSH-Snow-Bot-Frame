// =====================================================================
//  bridge/tulpa_mcp.ts —— Tulpa MCP 连接层（专用 JSON-RPC 客户端）
//
//  凭据（bearer）与地址由配置面板提供，不读取任何 DSH 连接存储文件。
//  严格限制为 127.0.0.1/localhost HTTP 端点——本插件只对接本机 Tulpa，
//  是专用连接层而非通用 MCP 抽象；将来接入第二个 MCP server 再抽通用层。
//
//  连接策略：每操作一连接（use() = initialize 握手 → fn → close），
//  无状态、不会遇到会话过期，代价是每次多 ~2 个 RTT 握手。
// =====================================================================

// 已握手、能调用工具的 MCP 客户端句柄（原 common/dsh_types 的 Transport，
// 更名后移到这里——它是本插件自己的接口，不是 DSH 宿主类型）。
export interface McpClient {
  serverName?: string;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

class TulpaMcp {
  constructor(private opts: { bearer: string; url?: string }) { }

  // 每操作一连接：initialize → fn(client) → close（fn 抛错也保证关闭）。
  async use<T>(fn: (client: McpClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => { });
    }
  }

  private async connect(): Promise<McpClient> {
    const bearer = this.opts.bearer?.trim();
    if (!bearer) throw new Error('缺少 Tulpa bearer 配置');
    let url: URL;
    try {
      url = new URL(this.opts.url?.trim() || 'http://127.0.0.1:18777/mcp');
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
}

export { TulpaMcp };
