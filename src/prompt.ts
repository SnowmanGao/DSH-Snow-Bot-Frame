// =====================================================================
//  prompt.ts —— 群聊提示词、工具说明与上下文裁剪规则
//
//  统一生成 QQ 群绑定提示词、回复节奏、记忆整理规则和历史工具说明；
//  同时声明发送给 QQ 会话前的 section/context 黑名单及 runtime 压缩规则。
//  具体裁剪由 common/prompt_trimmer.ts 执行，模块组装由 index.ts 负责。
// =====================================================================

import { removeTextBySentencePrefix } from './common/prompt_trimmer.js';
import { type ToolPrompt } from './common/tools_def_utils.js';

// 路径规范化与群工作目录计算。
function normDir(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '');
}
function workDir(groupId: string, workspace: string): string {
  return `${normDir(workspace)}/groups/${groupId}`;
}

// 系统提示词（system prompt）
function systemPromptBuilder(group: { groupId: string; groupName: string; }): string {
  return [
    `你是 QQ 群 "${group.groupName}"（群号 ${group.groupId}）中的一名群友。`,
    '每个群聊的工作目录互相隔离，文件操作只允许在本群工作目录内进行。',
    '获取聊天记录的后台软件代号 FatCat，若该软件出现问题：直接报告，不要尝试修复。',
    '',
    '## 人格与记忆',
    '- SOUL.md：本群独立人格。每次会话开始时读取，遵循其中的原则。',
    '- MEMORY.md：长期记忆，只记录稳定、有长期价值的信息，按需读取。',
    '- memory/YYYY-MM-DD.md：每日日志，记录当天重要事件、讨论结论、决定和待办，只追加。',
    '- memory/YYYY-MM.zip：历史日志月度归档，通常无需读取。',
    '- 只根据明确、稳定的信息更新人格和记忆；区分事实、个人观点与群体共识。',
    '- 外部操作、公开发布及代表群友作出的承诺必须谨慎处理。',
    '',
    '## 如何回复',
    '- 短回复一次发送完整内容，长回复自然地拆分发送。',
    '- 复杂或耗时任务先简短回应；执行期间长时间无进展时适当补充简短进度，完成后发送最终结果。',
    '- 需要补充群聊上下文时，使用以 "qqtool" 开头的工具。需要发送消息时，使用以 "qqbot" 开头的工具。',
    '- 只有通过 "qqbot" 工具发送的内容才会被其他人看见，assistant 文本仅自己可见，不会公开到群聊。',
    '- 发送成功后，必须再输出任意 assistant 文本（例如："已发送"），以空内容结束会导致报错！',
    '',
    '## 记忆管理',
    '- SOUL.md 只在长期交流足以支持稳定人格调整时修改，避免因单次事件改变人格。',
    '- MEMORY.md 是经过整理的长期记忆，允许更新、合并和删除过时信息，保持内容准确、精简。',
    '- 每日日志则仅允许追加记录，不修改或更新。追加时，在末尾写下 EOF 标记，方便下次 edit 时直接替换。',
    '- 每过一个月时，将上个月的日志 read 整理，提炼有长期价值的信息并更新 MEMORY.md。',
    '- 完成整理后，再调用 qqtool_archive_group_logs 工具，程序会自动将对应月份的日志归档为 .zip 文件。',
    '- zip 归档作为宝贵的历史记录保留，不得修改或覆盖。',
  ].join('\n');
}


const toolPrompts: Record<string, ToolPrompt> = {
  // 发送消息
  qqbot_send_message: {
    description: '最常用，在 QQ 中发送一条消息（支持 markdown）',
    parameters: {
      content: '要发送的消息（不超过 4500 字符）',
    },
  },

  // 历史查询
  qqtool_get_recent_messages: {
    description: '读取最新的 N 条消息，结果按从旧到新排序，可翻页',
    parameters: {
      limit: '消息条数，1~32，默认 8',
      cursor: '翻页游标，传上一页的 next_cursor 继续向前翻页',
    },
  },
  qqtool_search_messages: {
    description: '按时间、发送者和关键词筛选当前群消息，结果按从旧到新排序，可翻页。',
    parameters: {
      start: '起始时间（含），北京时间；格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS',
      end: '结束时间（不含），北京时间；格式同上，仅给日期表示当天 00:00:00',
      sender: '发送者 QQ 号（纯数字，精确匹配）或昵称（模糊匹配，可能重名或改名）',
      keyword: '消息内容的字面子串，精确匹配；不是语义搜索',
      sort: '截断取向：latest=截取最早结果，oldest=截取最近结果，默认 latest',
      limit: '本页最多返回条数，1~32，默认 8',
      cursor: '传入上一页的 next_cursor，其他查询条件保持不变，再次调用即可翻页',
    },
  },
  qqtool_get_message_context: {
    description: '读取某条消息的前后文',
    parameters: {
      id: '消息 ID',
      // 请勿修改上限！Tulpa 后端只接受上限最多为 8
      before: '向前展开条数，0~8，默认 8',
      after: '向后展开条数，0~8，默认 8',
    },
  },
  qqtool_get_message: {
    description: '完整读取折叠的单条消息，还可获取图片、附件、语音元数据',
    parameters: {
      id: '消息 ID',
    },
  },
  qqtool_fetch_media: {
    description: '按需下载某条消息的媒体内容。图片：下载到本地并返回路径；语音：返回转写的大致文本',
    parameters: {
      id: '消息 ID',
      index: '图片：填写消息 media 数组里的 index 字段；语音：忽略此参数',
    },
  },

  // 记忆归档
  qqtool_archive_group_logs: {
    description: '将指定月份的日志自动打包归档到 memory/YYYY-MM.zip，并自动清理原始日志',
    parameters: {
      month: '要归档的月份，格式为 YYYY-MM',
    },
  },
};

// 允许 bot 使用的工具（白名单的默认值）
const DEFAULT_TOOLS_ALLOWLIST = [
  "qqbot_send_file",
  "read", "write", "edit",
  "glob", "grep", "pwsh",
  "web_fetch", "web_search",
  "read_image"
];

// 无用的 section 提示词，移除以节约 token 消耗
const SECTIONS_TO_DROP: string[] = [
  'harness:identity',  // You are an AI agent powered by DeepSeek Harness.
  'deployment:persona-prefix',  // You are a coding agent powered by the xxx model.
  'context:file-reference',  // Tokens prefixed with @ are paths ... (本地文件引用吧唧)
  'harness:source',  // The runtime context names the DeepSeek Harness implementation checkout ...
  'app:web-surface',  // You are interacting with the user through the DeepSeek Harness Web GUI ...
  'tool:goal',  // create_goal may infer goal intent ...
  'tool:jobs',  // Track every background job id you start ...
  'tool:workflow',  // Use the workflow tool ONLY when ...
  'tool:subagent',  // Start independent delegations with `subagent` together ...
];

// 要压缩的 section 提示词：删除其中指定句子、保留其余
const SECTIONS_TO_COMPACT: Record<string, (text: string) => string> = {
  'ui:deliverable-file-references': (text) =>
    removeTextBySentencePrefix(text, ["Do not call", "Use present to", "Hosts that support", "Avoid repeating results", "append #L24 or", "Default to the"])
};

// 无用的 context 提示词，移除以节约 token 消耗
const CONTEXTS_TO_DROP: string[] = [
  'harness:source',  // Current DeepSeek Harness implementation checkout ...
  'app:web-surface',  // Current DeepSeek Harness Web GUI URL ...
  'skill-catalog',  // <system-reminder> A skill is a reusable ...
];


export {
  CONTEXTS_TO_DROP, DEFAULT_TOOLS_ALLOWLIST, SECTIONS_TO_COMPACT, SECTIONS_TO_DROP,
  systemPromptBuilder, toolPrompts, workDir
};
