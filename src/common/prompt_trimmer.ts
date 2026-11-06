// =====================================================================
//  prompt_trimmer.ts —— 提示词过滤、裁剪器
//
//  DSH 的 system prompt 由具名 section / context 组成，name 即稳定标识：
//  - 删（trimAssemblySections / trimAssemblyContexts）：按 name 黑名单移除整块
//  - 精简（compactByTransforms）：按 name 对 text 做转换
//   （tool:* 段由注册表 restrict 处理：条件渲染的段随工具移除自动变空）
// =====================================================================

import type { Assembly } from './dsh_types.js';

type Named = { name: string;[k: string]: unknown; };
type Sections = Assembly['sections'];
type Contexts = Assembly['contexts'];

// 按 name 精确匹配并移除整块；无规则时直接返回原数组
function removeByRules<T extends Named>(items: T[] | undefined, rules: string[]): T[] | undefined {
  if (!rules.length) return items;
  const ruleSet = new Set(rules);
  return (items ?? []).filter((item) => !ruleSet.has(item.name));
}

// 按给定变换函数压缩 prompt，未匹配的块保持不变。
// 返回原内容表示保留，返回空字符串表示清空该块
function compactByTransforms<T extends Named>(
  items: T[] | undefined,
  transforms: Record<string, (text: string) => string>,
): T[] | undefined {
  if (!items?.length) return items;
  return items.map((item) => {
    const transform = transforms[item.name];
    if (!transform || typeof item.text !== 'string') return item;
    return { ...item, text: transform(item.text) };
  });
}

function trimAssemblySections(sections: Sections, rules: string[]): Sections {
  return removeByRules(sections, rules);
}

function trimAssemblyContexts(contexts: Contexts, rules: string[]): Contexts {
  return removeByRules(contexts, rules);
}

export { compactByTransforms, trimAssemblyContexts, trimAssemblySections };
