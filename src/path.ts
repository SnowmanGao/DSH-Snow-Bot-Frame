// =====================================================================
//  path.ts —— 集中管理常用根路径（DSH 安装位置及其派生路径）
//
//  这些路径只依赖宿主环境（DSH_HOME、家目录），不属于用户个人配置，
//  统一放在这里，避免散落在各模块里重复计算。
// =====================================================================

import { homedir } from 'node:os';
import { join } from 'node:path';

// DSH 主目录（可用环境变量覆盖）
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

// dsh-qqbot 插件的 outbound.js（用于注入「抑制自动发送」patch）
const qqBotOutbound = join(
  dshHome, 'profiles', 'desktop', 'node_modules', '@tencent-connect', 'dsh-qqbot', 'lib', 'transport', 'outbound.js',
);

// dsh-qqbot 插件的 gateway/bootstrap.js（用于注入 qqbot_send_message 工具注册）
const qqBotBootstrap = join(
  dshHome, 'profiles', 'desktop', 'node_modules', '@tencent-connect', 'dsh-qqbot', 'lib', 'gateway', 'bootstrap.js',
);

// dsh-qqbot 插件的会话数据（用于获取 openid -> sessionId 映射）
const qqbotPrefs = join(homedir(), '.dsh-qqbot', 'model-prefs.json');

// 本插件自动学习的 openid → group 映射（无需手填，靠消息时间戳和内容联合匹配确认）
const learnedGroupsFile = join(homedir(), '.dsh-snow-bot-frame', 'learned-groups.json');

// desktop profile 根目录（配置写回 cordis.patch.yml 的目标）
const desktopProfileDir = join(dshHome, 'profiles', 'desktop');

export { dshHome, qqBotOutbound, qqBotBootstrap, desktopProfileDir, qqbotPrefs, learnedGroupsFile };
