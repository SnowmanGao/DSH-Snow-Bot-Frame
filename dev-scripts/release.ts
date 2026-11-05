#!/usr/bin/env node
// 发布脚本，由 package.json scripts 调用（node dev-scripts/release.ts <mode>）：
//   pnpm run pack-only   编译 -> 打包（不安装）
//   pnpm run release     编译 -> 打包 -> 安装到 DSH
// 
//   打包操作会使版本号++，防止 DSH 缓存旧版本
//   类型检查由 `pnpm run check` 承担；发布清单由 package.json files 白名单控制
//
// 环境变量覆盖：
//   DSH_PROFILE     目标 profile（默认 package.json config.dshProfile）
//   DSH_CLI         dsh.cmd 路径（默认 package.json config.dshCli）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mode = process.argv[2] === 'pack-only' ? 'pack-only' : 'release';

const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageJsonPath = path.join(root, 'package.json');
const profileName = process.env.DSH_PROFILE || meta.config?.dshProfile || 'desktop';
const dshCli = process.env.DSH_CLI || meta.config?.dshCli;
const dshHome = path.join(process.env.DSH_USERPROFILE || os.homedir(), '.dsh');
const outDir = path.join(dshHome, 'plugin-packages', meta.name);
const pnpm = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');

function run(command: string, args: string[], cwd?: string) {
  const isBatch = /\.cmd$|\.bat$/i.test(command);
  const r = spawnSync(isBatch ? 'cmd.exe' : command, isBatch ? ['/c', command, ...args] : args, { stdio: 'inherit', cwd });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Failed (${r.status}): ${command} ${args.join(' ')}`);
}

// 1. 编译（TS7 原生编译器，lib/tsc.js 为 JS 壳）
function build() {
  const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!fs.existsSync(tsc)) throw new Error('typescript not installed; run `pnpm install` first');
  run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], root);
}

// 2. 打包（发布内容由 package.json files 白名单控制）
function pack(): string {
  // 使得版本号 +1
  const versionParts = meta.version.split('.');
  if (
    versionParts.length !== 3 ||
    versionParts.some((part: string) => !/^\d+$/.test(part))
  ) throw new Error(`Invalid package version: ${meta.version}`);
  versionParts[2] = String(Number(versionParts[2]) + 1);
  meta.version = versionParts.join('.');
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(meta, null, 2)}\n`);
  // 开始打包
  fs.mkdirSync(outDir, { recursive: true });
  run(process.execPath, [pnpm, 'pack', '--pack-destination', outDir], root);
  const tarball = path.join(outDir, `${meta.name}-${meta.version}.tgz`);
  if (!fs.existsSync(tarball)) throw new Error(`Package missing: ${tarball}`);
  console.log(`Packed ${meta.version}: ${tarball}`);
  return tarball;
}

// 3. 安装到 DSH
function install(tarball: string) {
  if (!dshCli) throw new Error('DSH CLI not configured; set package.json config.dshCli or DSH_CLI.');
  if (!fs.existsSync(dshCli)) throw new Error(`DSH CLI not found: ${dshCli}`);
  run(dshCli, ['plugin', '--profile', profileName, 'add', tarball], outDir);
}

const started = Date.now();
try {
  build();
  const tarball = pack();
  if (mode === 'pack-only') { console.log('Pack only; nothing installed.'); process.exit(0); }
  install(tarball);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Restart DSH to load the changes.`);
} catch (e: any) {
  console.error(`\nRelease failed: ${e.message}`);
  process.exit(1);
}
