// =====================================================================
//  source_patcher.ts —— 通用源码 patch 工具
//
//  参考 @gaogaotiantian/dowhen 的风格：在源码锚点（trigger）上
//  挂回调（callback），handler 可注入、还原、查询状态。
//
//  trigger  = 目标源码锚点
//  callback = 注入后的代码
//  handler  = inject / revert / isInjected
//
//  与运行时 monkey-patch 不同，源码 patch 直接改写目标文件源码，
//  改完需重启宿主让依赖模块重新加载才生效。
// =====================================================================

import { readFileSync, writeFileSync } from 'node:fs';

type PatchSpec = {
  /* 目标文件绝对路径 */
  file: string;
  /* 源码锚点（原片段） */
  before: string;
  /* 注入后的片段 */
  after: string;
  /* 可选：注入前先清除匹配的旧注入块（after 内容演进时，旧版会残留叠加） */
  clear?: RegExp;
};

// handler：管理一个源码 patch 的注入、还原、状态
class SourcePatcher {
  constructor(private spec: PatchSpec) { }

  private read(): string {
    try {
      return readFileSync(this.spec.file, 'utf8');
    } catch {
      // 文件不存在视为空
      return '';
    }
  }

  // 注入：before → after，已注入或找不到锚点时返回 false。
  // 若指定 clear，先清除匹配的旧注入块，避免 after 演进后新旧叠加。
  // 注意：先判「已注入最新版」再 clear，否则会把最新版也清掉、破坏幂等。
  inject(): boolean {
    let content = this.read();
    if (content.includes(this.spec.after)) return false;
    if (this.spec.clear) content = content.replace(this.spec.clear, '');
    if (!content.includes(this.spec.before)) return false;
    writeFileSync(this.spec.file, content.replace(this.spec.before, this.spec.after));
    return true;
  }

  // 还原：after → before，未注入时返回 false
  revert(): boolean {
    const content = this.read();
    if (!content.includes(this.spec.after)) return false;
    writeFileSync(this.spec.file, content.replace(this.spec.after, this.spec.before));
    return true;
  }

  isInjected(): boolean {
    return this.read().includes(this.spec.after);
  }
}

export { SourcePatcher, type PatchSpec };
