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
  // 读取一张已缓存图片的像素。Tulpa 的 read_image 工具把图片以 base64 塞进
  // MCP 响应的 image content 块（structuredContent 只含元数据），需单独提取。
  readImage(message_id: number, index?: number): Promise<{ meta: Record<string, unknown>; images: { mimeType: string; data: string }[] }>;
  close(): Promise<void>;
}

// 把 fetch 失败翻译成人类可读、可指导行动的提示。Tulpa 未启动时 Node 的
// undici fetch 只会抛 `TypeError: fetch failed`，真正原因藏在 cause 链的
// code 字段（ECONNREFUSED / ECONNRESET / ETIMEDOUT / ENOTFOUND ...）。
function describeFetchFailure(url: URL, e: unknown): string {
  const host = `${url.hostname}:${url.port || (url.protocol === 'http:' ? 80 : 443)}`;
  const err = e as { name?: string; message?: string; cause?: unknown } | undefined;

  // 超时 / 主动中止
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(err?.message ?? '')) {
    return `Tulpa（FatCat）无响应：连接 ${host} 超时，可能已卡死或负载过高`;
  }

  // 沿 cause 链收集底层错误码
  const codes = new Set<string>();
  for (let c: any = err; c; c = c.cause) {
    if (typeof c?.code === 'string') codes.add(c.code);
  }

  if (codes.has('ECONNREFUSED')) {
    return `后端未启动：无法连接 ${host}（连接被拒绝），请启动后再重试`;
  }
  if (codes.has('ECONNRESET')) {
    return `后端连接被重置：${host} 断开连接，后端可能正在重启或已停止`;
  }
  if (codes.has('ETIMEDOUT')) {
    return `后端连接超时：${host} 长时间无响应，请确认后端是否仍在运行`;
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return `无法解析主机 ${host}，请检查后端 MCP 地址配置`;
  }

  // 兜底：把最底层错误码带出来，方便进一步定位
  const codeStr = [...codes].join('/') || (err?.name ?? 'unknown');
  return `后端连接失败：${host}（${codeStr}），这个错误需要用户仔细排查`;
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

      let response: Response;
      try {
        response = await fetch(url, {
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
      } catch (e) {
        throw new Error(describeFetchFailure(url, e));
      }

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

    // 图片像素：Tulpa 的 read_image 工具把图片以 base64 塞进响应的 image
    // content 块（structuredContent 只含 message_id/index/frame 元数据），
    // 必须单独从 content 里提取。图片未缓存时工具会以 isError + error 返回。
    const readImage = async function (message_id: number, index = 0) {
      const result = await request('tools/call', { name: 'read_image', arguments: { message_id, index } });
      const meta = (result.structuredContent ?? {}) as Record<string, unknown>;
      if (result.isError) {
        const msg = typeof meta?.error === 'string' && meta.error ? meta.error : 'read_image 失败';
        throw new Error(msg);
      }
      const images = (result.content ?? [])
        .filter((x: any) => x.type === 'image' && typeof x.data === 'string')
        .map((x: any) => ({ mimeType: String(x.mimeType ?? 'image/jpeg'), data: x.data as string }));
      if (images.length === 0) throw new Error('read_image 未返回图片像素（图片可能未在本机缓存）');
      return { meta, images };
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
      return { serverName: 'tulpa', call, readImage, close };

    } catch (error) {
      // 初始化失败也要释放已创建的 session
      await close().catch(() => { });
      throw error;
    }
  }
}
