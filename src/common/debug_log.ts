// =====================================================================
//  debug_log.ts —— 插件自身的文件日志（供排查用）
//
//  DSH 的 ctx.logger 走 Electron 主进程 stdout，桌面版默认不落盘，
//  用户看不到。这里额外追加写一份日志文件（默认放桌面，防遗忘）。
//  排查时直接打开查看 [snow-bot] 前缀的日志。
//
//  注意：这只是排查期的临时手段。功能稳定后应删除本文件日志，改回
//  原生日志（ctx.logger + DSH 的 --log-level 即可查看）。
//
//  只写文件、不抛异常、不依赖任何宿主服务。
// =====================================================================

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// 日志文件放在桌面（显眼、防遗忘）；桌面不存在则回退到家目录隐藏目录。
function resolveLogFile(): string {
  const candidates = [
    join(homedir(), 'Desktop'),
    join(homedir(), 'OneDrive', 'Desktop'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return join(dir, 'dsh-snow-bot-frame.debug.log');
  }
  return join(homedir(), '.dsh-snow-bot-frame', 'debug.log');
}

const logFile = resolveLogFile();

function dbg(...args: unknown[]): void {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const line = `[${time}] ${args.map(String).join(' ')}\n`;
    appendFileSync(logFile, line, 'utf8');
  } catch {
    /* 日志写失败不致命 */
  }
}

export { dbg, logFile };
