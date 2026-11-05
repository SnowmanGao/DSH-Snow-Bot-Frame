// =====================================================================
//  tulpa_mcp.ts —— Tulpa MCP 专用连接层
//
//  凭据与地址由配置面板提供。
//  仅支持 127.0.0.1 / localhost HTTP 端点。
//
//  连接策略：每操作一连接
//  use() = initialize → fn(client) → close
// =====================================================================


export interface McpClient {
  serverName?: string;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export class TulpaMcp {
  // 串行化队列：Tulpa 的 MCP 端点对并发连接有限制（并发 initialize 时，
  // 后一个连接的工具调用会返回 HTTP 409）。这里把所有 use() 串成一条链，
  // 前一个完成（含 close）后再执行下一个，避免并发撞车。
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: {
    bearer: string;
    url?: string;
  }) { }

  // 每次操作独立连接，自动管理生命周期；跨操作串行执行。
  async use<T>(
    fn: (client: McpClient) => Promise<T>
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const client = await this.connect();
      try {
        return await fn(client);
      } finally {
        await client.close().catch(() => { });
      }
    };
    const p = this.queue.then(run, run);
    // 队列吞掉错误，保证后续调用不被上一次失败卡死
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  // 创建并初始化 MCP 客户端
  private async connect(): Promise<McpClient> {
    const bearer = this.opts.bearer?.trim();
    if (!bearer) {
      throw new Error('缺少 Tulpa bearer 配置');
    }

    let url: URL;
    try {
      url = new URL(this.opts.url?.trim() || 'http://127.0.0.1:18777/mcp');
    } catch {
      throw new Error('Tulpa 地址不合法');
    }

    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
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
    let closed = false;

    // 统一处理 JSON-RPC 请求
    const request = async (method: string, params: unknown, notify = false): Promise<any> => {
      const id = notify ? undefined : ++seq;

      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...headers,
          ...(session ? { 'Mcp-Session-Id': session } : {}),
          'MCP-Protocol-Version': protocol,
        },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(id !== undefined ? { id } : {}),
          method,
          params,
        }),
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Tulpa HTTP ${response.status}`);
      }

      session = response.headers.get('mcp-session-id') ?? session;
      const text = await response.text();
      if (notify && !text.trim()) return {};

      let messages: any[];
      try {
        messages = response.headers.get('content-type')?.includes('text/event-stream')
          ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
          : [JSON.parse(text)];
      } catch {
        throw new Error('Malformed Tulpa protocol response');
      }

      const payload = messages.find(x => x.id === id) ?? messages.at(-1);
      if (payload?.error) throw new Error('Tulpa protocol error');
      return payload?.result ?? {};
    };

    const call = async function (name: string, args?: Record<string, unknown>) {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(`Tulpa rejected ${name}`);
      if (result.structuredContent) return result.structuredContent;
      const text = (result.content ?? [])
        .filter((x: any) => x.type === 'text')
        .map((x: any) => x.text)
        .join('\n');
      try { return JSON.parse(text); }
      catch { throw new Error(`Tulpa ${name} returned non-JSON`); }
    };

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const currentSession = session;
      session = null;
      if (!currentSession) return;
      const response = await fetch(url, {
        method: 'DELETE',
        redirect: 'error',
        headers: {
          ...headers,
          'Mcp-Session-Id': currentSession,
          'MCP-Protocol-Version': protocol,
        },
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
    };

    try {
      // MCP initialize 握手
      const init = await request('initialize', {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: {
          name: 'dsh-snow-bot-frame',
          version: '0.4.0',
        },
      });

      protocol = init.protocolVersion ?? protocol;
      await request('notifications/initialized', {}, true);

      // 最终返回
      return { serverName: 'tulpa', call, close };

    } catch (error) {
      // 初始化失败也要释放已创建的 session
      await close().catch(() => { });
      throw error;
    }
  }
}
