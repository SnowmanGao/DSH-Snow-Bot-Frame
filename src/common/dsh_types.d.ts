// 运行时共享类型。宿主（DSH / cordis）内部结构不稳定，仅声明本插件用到的字段。

// Tulpa 只读传输句柄
export interface Transport {
  serverName?: string;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export type TransportFactory = (opts?: { bearer: string; url?: string; }) => Promise<Transport>;

// 提示词组装对象（结构宽松，只关心 sections / tools）
export interface Assembly {
  sections?: { name: string; text?: unknown;[k: string]: unknown; }[];
  contexts?: { name: string; text?: unknown;[k: string]: unknown; }[];
  tools?: { name: string; description?: unknown; parameters?: unknown;[k: string]: unknown; }[];
  [k: string]: unknown;
}

// DSH Agent 对象
export interface Agent {
  id: string;
  session: {
    id: string;
    header?: { cwd?: string, [k: string]: unknown; };
    [k: string]: unknown;
  };
  ctx: {
    on(event: string, handler: (...args: any[]) => any): () => void;
    tools: { register(def: unknown): unknown; };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// Cordis 插件上下文
export interface Ctx {
  on(event: string, handler: (...args: any[]) => any): () => void;
  get(name: string): any;
  // 可选注入服务（如 webServer）；deps 未就绪时回调不运行，就绪/替换时重跑
  inject?(names: string[], callback: (scoped: { [k: string]: any; effect?(fn: () => () => void, id?: string): void; }) => void): void;
  logger?: { info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; };
  [k: string]: unknown;
}

export interface Ref<T> {
  get(): T;
}