// =====================================================================
//  index.ts —— 入口：仅 re-export 插件装配与配置声明
//  （类比 Vue 的 main.ts：真正逻辑见 plugin.ts / config_schema.ts）
// =====================================================================

export { apply } from './plugin.js';
export { Config } from './config_schema.js';
