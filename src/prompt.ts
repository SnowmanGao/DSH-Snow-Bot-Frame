// =====================================================================
//  prompt.ts —— 群聊提示词、工具说明与上下文裁剪规则
//
//  统一生成 QQ 群绑定提示词、回复节奏、记忆整理规则和历史工具说明；
//  同时声明发送给 QQ 会话前的 section/context 黑名单及 runtime 压缩规则。
//  具体裁剪由 common/prompt_trimmer.ts 执行，模块组装由 index.ts 负责。
// =====================================================================

// 路径规范化与群工作目录计算。
function normDir(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '');
}
function workDir(groupId: string, workspace: string): string {
  return `${normDir(workspace)}/groups/${groupId}`;
}

// 系统提示词（system prompt）
// 真隔离：会话工作目录已由 runtime 用官方 workingDirectory 服务切到本群目录，
// 因此这里不再注入绝对路径，文件一律使用相对路径。
function systemPromptBuilder(group: { groupId: string; groupName: string; }): string {
  return [
    `你是 QQ 群 "${group.groupName}"（群号 ${group.groupId}）中的一名群友。`,
    '每个群聊的工作目录互相隔离：文件操作只允许在本群工作目录内进行。',
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
    '- 需要补充群聊上下文时，使用以 "qqtool" 开头的工具查询本群历史。需要发送消息时，使用以 "qqbot" 开头的工具。',
    '- 向 QQ 群发送文字必须显式调用 qqbot_send_message，普通 assistant 文本（包括最终回复）不会公开到群聊。',
    '- qqbot_send_message 成功后，必须原样输出 assistant 文本 "已发送"，然后再结束本轮，否则会报错！',
    '',
    '## 记忆管理',
    '- SOUL.md 只在长期交流足以支持稳定人格调整时修改，避免因单次事件改变人格。',
    '- MEMORY.md 是经过整理的长期记忆，允许更新、合并和删除过时信息，保持内容准确、精简。',
    '- 每日日志则仅允许追加记录，不应修改或更新。追加时，在末尾写上 EOF 标记，方便下次 edit 时替换。',
    '- 每过一个月时，将上个月的日志 read 整理，提炼有长期价值的信息并更新 MEMORY.md。',
    '- 完成整理后，调用 qqtool_archive_group_logs 工具，程序会自动将对应月份的日志归档为 YYYY-MM.zip。',
    '- zip 归档作为宝贵的历史记录保留，不得修改或覆盖。',
  ].join('\n');
}

// tools_of_history 的工具提示词
const historyToolPrompts = {
  qqtool_get_recent_messages: '读取当前群最近消息，按时间正序；cursor 沿用返回的 next_cursor 继续向前翻页。',
  qqtool_search_messages: '当前群按北京时间、账号或昵称、字面关键词组合检索（条件为 AND）；cursor 翻页。',
  qqtool_get_message_context: '展开当前群某条消息的前后文；before/after 为 1~32。',
  qqtool_get_message: '完整读取单条消息，展开折叠长文本；缺失的图片、附件、语音只给元数据与缺失标记。',
};

// tools_of_memory 的工具提示词
const memoryToolPrompts = {
  qqtool_archive_group_logs: '将指定月份（YYYY-MM）的日志打包归档为 memory/YYYY-MM.zip，并删除原始日志。归档前必须先完成整理。',
};

// 允许 bot 使用的工具（白名单的默认值）
const DEFAULT_TOOLS_ALLOWLIST = [
  "qqbot_send_file",
  "read", "write", "edit",
  "glob", "grep", "pwsh",
  "web_fetch"
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
    text.replace(
      new RegExp(`(?:${[
        'Do not call', 'Use present when',
        'Each presented file', 'Avoid repeating results',
        'append #L24 or', 'Default to the',
      ].join('|')})[\\s\\S]*?\\.\\s*`, 'g'),
      '',
    ),
};

// 无用的 context 提示词，移除以节约 token 消耗
const CONTEXTS_TO_DROP: string[] = [
  'harness:source',  // Current DeepSeek Harness implementation checkout ...
  'app:web-surface',  // Current DeepSeek Harness Web GUI URL ...
  'skill-catalog',  // <system-reminder> A skill is a reusable ...
];


export {
  CONTEXTS_TO_DROP, DEFAULT_TOOLS_ALLOWLIST, SECTIONS_TO_DROP, SECTIONS_TO_COMPACT,
  historyToolPrompts, memoryToolPrompts, systemPromptBuilder, workDir
};
