// =====================================================================
//  tools_of_memory.ts —— 群记忆文件的初始化与日志归档
//
//  群目录基础文件由 ensureGroupFiles 负责：SOUL.md（首次从 assets/SOUL.md
//  复制默认人格模板）、MEMORY.md（首次创建空文件）。二者只补缺失、不覆盖
//  已有内容，人格与记忆由 AI 按 systemPromptBuilder 里的规则后续维护。
//
//  qqtool_archive_group_logs 工具把指定月份的每日日志（memory/YYYY-MM-DD.md）
//  打包为 memory/YYYY-MM.zip 并删除已归档的原始日志，供 AI 在完成月度
//  整理后调用。
// =====================================================================

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILED_TIPS } from './bridge/qqbot_prefs.js';
import type { ResolvedGroup } from './group_resolver.js';
import { memoryToolPrompts, workDir } from './prompt.js';

// 默认人格模板源文件（随包发布到 assets/，不再硬编码到代码里）。
// 编译后本文件在 dist/、源在包根 assets/，相对 ../assets/SOUL.md；
// tsx 开发态本文件在 src/，相对路径同为 ../assets/SOUL.md，二者一致。
const DEFAULT_SOUL_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/SOUL.md');

// 确保群目录基础文件存在：SOUL.md（默认模板）+ MEMORY.md（空文件）。
// 幂等：文件已存在则不覆盖。
function ensureGroupFiles(groupId: string, workspace: string): void {
  const dir = workDir(groupId, workspace);
  mkdirSync(dir, { recursive: true });
  const soulPath = `${dir}/SOUL.md`;
  const memoryPath = `${dir}/MEMORY.md`;
  if (!existsSync(soulPath)) copyFileSync(DEFAULT_SOUL_SRC, soulPath);
  if (!existsSync(memoryPath)) writeFileSync(memoryPath, '', 'utf8');
}

// 归档指定月份（YYYY-MM）的日志：memory/YYYY-MM-*.md → memory/YYYY-MM.zip。
// 打包成功（zip 已生成）后才删除原始日志；失败则不删，保持可重试。
function archiveGroupLogs(groupId: string, workspace: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month 参数格式应为 YYYY-MM，如 2026-10');
  const dir = workDir(groupId, workspace);
  const memoryDir = `${dir}/memory`;
  if (!existsSync(memoryDir)) throw new Error('memory 目录不存在，没有可归档的日志');

  const files = readdirSync(memoryDir)
    .filter((f) => f.startsWith(`${month}-`) && f.endsWith('.md'))
    .sort();
  if (files.length === 0) throw new Error(`${month} 月份没有可归档的日志`);

  const zipPath = `${memoryDir}/${month}.zip`;
  if (existsSync(zipPath)) throw new Error(`${month}.zip 已存在，请勿重复归档`);

  try {
    const paths = files.map((f) => `'${memoryDir}/${f}'`).join(',');
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path ${paths} -DestinationPath '${zipPath}' -Force`,
    ], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`压缩失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!existsSync(zipPath)) throw new Error('归档失败：zip 未生成');

  const removed: string[] = [];
  for (const f of files) {
    try {
      unlinkSync(`${memoryDir}/${f}`);
      removed.push(f);
    } catch { /* 单个删除失败不致命，zip 已保留 */ }
  }

  return { archived: removed.length, month, zip: `memory/${month}.zip`, files: removed };
}

// 记忆工具的完整定义（当前只有 qqtool_archive_group_logs）。
// 归档是纯本地文件操作，只需 resolve 出 groupId + workspace，不依赖 Tulpa。
// openid 由调用方以 getOpenid() 懒解析（agent 创建时 prefs 可能尚未落盘）。
function createMemoryTools(
  getOpenid: () => string | undefined,
  resolveGroup: (openid: string) => Promise<ResolvedGroup | undefined>,
  workspace: string,
) {
  const str = { type: 'string' };
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };

  const parameters = {
    qqtool_archive_group_logs: { type: 'object', properties: { month: str }, required: ['month'], additionalProperties: false },
  };
  type ToolName = keyof typeof parameters;

  const run = async (name: ToolName, args: any) => {
    const openid = getOpenid();
    if (!openid) throw new Error(FAILED_TIPS);
    const group = await resolveGroup(openid);
    if (!group) throw new Error(FAILED_TIPS);
    switch (name) {
      case 'qqtool_archive_group_logs': return archiveGroupLogs(group.groupId, workspace, args.month);
    }
  };

  return (Object.keys(parameters) as ToolName[]).map((name) => ({
    name,
    description: memoryToolPrompts[name],
    parameters: parameters[name],
    output,
    async execute(args: any) { return run(name, args); },
  }));
}

export { archiveGroupLogs, createMemoryTools, ensureGroupFiles };
