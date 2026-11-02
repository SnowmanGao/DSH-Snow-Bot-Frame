// =====================================================================
//  prompt_trimmer.ts —— 提示词裁剪的通用纯函数
//
//  只放「与业务无关」的裁剪原语，不内置任何 QQ/群聊规则（具体删哪些、
//  精简哪些，由调用侧 prompt.ts 声明，index.ts 组装注册）。
//
//  DSH 的 system prompt 由若干具名 section / context 组成，name 即稳定
//  标识。裁剪无非两种操作：
//    - 删（remove）：按 name 黑名单移除整个块
//    - 精简（compact）：按 name 对 text 做转换
//
//  规则字符串约定（删块用）：
//    - 以 '*' 结尾 → 前缀匹配（如 harness:*）
//    - 否则        → 精确匹配 name
// =====================================================================

import type { Assembly } from './dsh_types.js';

type Named = { name: string; [k: string]: unknown };
type Sections = Assembly['sections'];
type Contexts = Assembly['contexts'];

type Matcher = [type: 'full' | 'prefix', pattern: string];

function buildMatchers(rules: string[]): Matcher[] {
  return rules.map((r) => (r.endsWith('*') ? ['prefix', r.slice(0, -1)] : ['full', r]));
}

// 通用：按黑名单删块（精确 + 前缀匹配）。
function removeByRules<T extends Named>(items: T[] | undefined, rules: string[]): T[] | undefined {
  if (!rules.length) return items;
  const matchers = buildMatchers(rules);
  return (items ?? []).filter(
    (item) => !matchers.some((m) =>
      (m[0] === 'full' && item.name === m[1]) ||
      (m[0] === 'prefix' && item.name.startsWith(m[1]))
    )
  );
}

// 通用：name 以 prefix 开头的块，只保留去掉前缀后命中 allow 的；非该前缀的块原样保留。
function keepByPrefix<T extends Named>(items: T[] | undefined, prefix: string, allow: string[]): T[] | undefined {
  if (!items?.length) return items;
  if (!allow.length) {
    // 空白名单：该前缀下的块全部删除。
    return items.filter((item) => !item.name.startsWith(prefix));
  }
  const allowSet = new Set(allow);
  return items.filter((item) =>
    !item.name.startsWith(prefix) || allowSet.has(item.name.slice(prefix.length))
  );
}

// 通用：按 name 对 text 做转换。transforms 未命中的块原样保留；
// 命中的用函数改写 text（函数返回原 text 表示不改，返回空串表示清空）。
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

// 以下为带类型的便捷封装（sections / contexts）。

function trimAssemblySections(sections: Sections, rules: string[]): Sections {
  return removeByRules(sections, rules);
}

function trimAssemblyContexts(contexts: Contexts, rules: string[]): Contexts {
  return removeByRules(contexts, rules);
}

export {
  trimAssemblySections,
  trimAssemblyContexts,
  removeByRules,
  keepByPrefix,
  compactByTransforms,
};
