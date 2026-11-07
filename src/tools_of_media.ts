// =====================================================================
//  tools_of_media.ts —— 历史消息媒体按需获取
//
//  历史工具只返回媒体的元数据（media[].kind / media[].index）。模型需要
//  真正「看到」内容时，用本脚本的 qqtool_fetch_media 按需获取（懒加载）：
//   - 图片（image/gif/sticker）：下载到群工作目录 .media/，返回本地路径，
//     模型再用 DSH 的 read_image 读取。
//   - 语音（voice）：调用 Tulpa 的 transcribe_voice 本地转写，返回时长、
//     转写文本、语言等。
//
//  注意：Tulpa 的语音消息不进 media 数组，在消息上的 voice 字段读取。
// =====================================================================

import { access, mkdir, writeFile } from 'node:fs/promises';
import { FAILED_TIPS } from './bridge/qqbot_prefs.js';
import type { McpClient, TulpaMcp } from './bridge/tulpa_mcp.js';
import type { ResolvedGroup } from './group_resolver.js';
import { toolPrompts, workDir } from './prompt.js';
import { hydrateParameters, type ParamDef } from './common/tools_def_utils.js';
import type { ToolDef } from './common/dsh_types.js';
import { TulpaConversation } from './bridge/tulpa_conversation.js';


class MediaUtil extends TulpaConversation {
  constructor(
    t: McpClient,
    binding: { platform?: string; conversation_id: string; },
    private groupDir: string,
  ) {
    super(t, binding);
  }

  // 按需获取某条消息的媒体内容（懒加载）：
  //  - 图片：下载到本地，返回 { success:true, kind, path }。
  //  - 语音：本地转写，返回 { success:true, kind:'voice', duration_ms, transcript, ... }。
  // 预期的失败（媒体不存在、不可读、类型不支持、转写失败）返回 { success:false, error }。
  async fetchMedia(args: { id: number; index?: number; }) {
    const { id } = args;
    const snapshot = await this.scope();
    const raw = await this.get(id, snapshot);
    const media = Array.isArray(raw.media) ? raw.media : [];
    const voice = raw.voice as Record<string, unknown> | undefined;

    // 语音判定：消息带 voice 字段（_admit 注入），或 media 为空且 content 是
    // [语音消息] 占位符。语音按 message_id 整条转写，index 不适用。
    const isVoice = !!voice || (media.length === 0 && String(raw.content ?? '').trim() === '[语音消息]');
    if (isVoice) return this.fetchVoice(id);

    // 图片：按 index 定位 media 条目。
    const index = number(args.index, 0);
    const item = media.find((x: any) => Number(x?.index) === index) as Record<string, unknown> | undefined;
    if (!item) return { success: false, error: '媒体不存在（index 越界或该消息无附件）' };
    const kind = String(item.kind ?? '').toLowerCase();
    if (kind !== 'image' && kind !== 'gif' && kind !== 'sticker') return { success: false, error: `暂不支持该媒体类型：${kind || 'unknown'}` };
    if (item.available === false) return { success: false, error: '图片本机不可读（未缓存）' };
    const path = await this.fetchImage(id, index);
    return { success: true, kind, path };
  }

  // 语音转写：转发 Tulpa 的 transcribe_voice 结果，抽取对 LLM 有用的字段。
  // 返回结构（Tulpa voice.py evidence()）：{ duration_ms, transcript, language,
  //   status, availability, codec, model, backend, note, error, truncated? }。
  private async fetchVoice(id: number) {
    const result = await this.t.call('transcribe_voice', { message_id: id });
    if (result?.error) return { success: false, error: String(result.error) };
    const v = result?.voice as Record<string, unknown> | undefined;
    if (!v) return { success: false, error: '语音不可用（原语音可能已删除）' };
    // Tulpa 转写失败时不抛协议错误（仅是返回 status='failed', error='...'）。
    // 此处必须把 success 置为 false，否则模型会看到 "success:true" 却没有 transcript。
    const failed = v.status === 'failed' || (typeof v.error === 'string' && !!v.error);
    const out: Record<string, unknown> = { success: !failed, kind: 'voice' };
    // 只留有用的字段
    for (const k of ['duration_ms', 'transcript', 'language', 'note']) {
      if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
    }
    if (v.truncated === true) out.truncated = true;
    if (typeof v.error === 'string' && v.error) out.error = v.error;
    return out;
  }

  // 按需获取图片像素（走 Tulpa 的 read_image 工具），落地到 .media/<id>_<index>.jpg。
  // read_image 统一返回 JPEG（GIF 最多 3 帧、每帧一个 image 块）；已落地则复用。
  private async fetchImage(mid: number, index: number): Promise<string> {
    const dir = `${this.groupDir}/.media`;
    await mkdir(dir, { recursive: true });
    const file = `${dir}/${mid}_${index}.jpg`;
    try {
      await access(file);
      return file; // 已落地，复用
    } catch { /* 未落地，走 read_image */ }
    const { images } = await this.t.readImage(mid, index);
    // 单帧是常态；GIF 多帧先落第一帧（多帧后续再扩展）。
    const buf = Buffer.from(images[0].data, 'base64');
    await writeFile(file, buf);
    return file;
  }
}

// qqtool_fetch_media 工具定义：从 openid 解析所属群，按需获取媒体。
function createMediaTools(
  mcp: TulpaMcp,
  getOpenid: () => string | undefined,
  resolveGroup: (openid: string) => Promise<ResolvedGroup | undefined>,
  workspace: string,
): ToolDef[] {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] };

  const paramDefs: Record<string, ParamDef> = {
    id: { type: 'integer', required: true },
    index: { type: 'integer' },
  };

  const run = async (args: any) => {
    const openid = getOpenid();
    if (!openid) throw new Error(FAILED_TIPS);
    const group = await resolveGroup(openid);
    if (!group) throw new Error(FAILED_TIPS);
    const binding = { platform: 'qq', conversation_id: group.conversationId };
    const groupDir = workDir(group.groupId, workspace);
    return mcp.use(async (t) => {
      const m = new MediaUtil(t, binding, groupDir);
      return m.fetchMedia(args);
    });
  };

  return [{
    name: 'qqtool_fetch_media',
    description: toolPrompts.qqtool_fetch_media.description,
    parameters: hydrateParameters(toolPrompts.qqtool_fetch_media.parameters, paramDefs),
    output,
    async execute(args: any) { return run(args); },
  }];
}

// 与 tools_of_history.ts 的同名函数保持一致（校验整数参数范围）。
function number(x: unknown, fallback: number, max = 64): number {
  const v = (x ?? fallback) as number;
  if (!Number.isInteger(v) || v < 0 || v > max) throw new Error('Integer parameter out of range');
  return v;
}


export { createMediaTools, MediaUtil };
