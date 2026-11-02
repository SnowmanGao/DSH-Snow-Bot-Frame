// =====================================================================
//  bridge/paths.ts —— 集中管理外部系统的常用路径
//
//  这些路径只依赖宿主环境（DSH_HOME、家目录），不属于用户个人配置，
//  统一放在这里，避免散落在各模块里重复计算。
// =====================================================================

import { homedir } from 'node:os';
import { join } from 'node:path';

// DSH 主目录（可用环境变量 DSH_HOME 覆盖）
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

// dsh-qqbot 根目录（desktop profile 实际运行版本）
const qqBotLib = join(
  dshHome, 'profiles', 'desktop', 'node_modules', '@tencent-connect', 'dsh-qqbot', 'lib',
);

// dsh-qqbot 的 outbound.js（route() 所在，抑制自动发送的 patch 目标）
const qqBotOutbound = join(qqBotLib, 'transport', 'outbound.js');

// dsh-qqbot 的 gateway/bootstrap.js（registerSendFileTool 调用处，注入发送工具的 patch 目标）
const qqBotBootstrap = join(qqBotLib, 'gateway', 'bootstrap.js');

// dsh-qqbot 的会话偏好（openid → sessionId 映射，由官方插件维护落盘）
const qqbotPrefs = join(homedir(), '.dsh-qqbot', 'model-prefs.json');

// 本插件自动学习的 openid → 群 映射（无需手填，靠消息时间戳+内容配对后落盘）
const learnedGroupsFile = join(homedir(), '.dsh-snow-bot-frame', 'learned-groups.json');

// desktop profile 根目录（配置写回 cordis.patch.yml 的目标）
const desktopProfileDir = join(dshHome, 'profiles', 'desktop');

export { dshHome, qqBotLib, qqBotOutbound, qqBotBootstrap, desktopProfileDir, qqbotPrefs, learnedGroupsFile };
