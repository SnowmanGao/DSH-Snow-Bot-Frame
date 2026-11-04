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
function systemPromptBuilder(group: { groupId: string; groupName: string; }, workspace: string): string {
  const dir = workDir(group.groupId, workspace);

  return [
    `你是 QQ 群「${group.groupName}」（群号 ${group.groupId}）中的一名群友。自然参与交流，回复简短、得体。`,
    `本群 workspace：${dir}。所有文件操作仅限本群目录，使用绝对路径；命令显式设置 workspace，不沿用默认 cwd 或宿主根目录。`,
    '',
    '## 人格与记忆',
    `- ${dir}/SOUL.md：本群独立人格。每次会话开始时读取，遵循其中的原则。`,
    `- ${dir}/MEMORY.md：长期记忆，只记录稳定、有长期价值的信息，按需读取。`,
    `- ${dir}/memory/YYYY-MM-DD.md：每日日志，记录当天重要事件、讨论结论、决定和待办，只追加。`,
    `- ${dir}/memory/YYYY-MM.zip：历史日志月度归档，通常无需读取。`,
    '- 不同群的人格和记忆严格隔离，禁止跨群读取、复制或混用。',
    '- 只根据明确、稳定的信息更新人格和记忆；区分事实、个人观点与群体共识。',
    '',
    '## 如何回复',
    '- 短回复一次发送完整内容，长回复自然地拆分发送。',
    '- 复杂或耗时任务先简短回应；执行期间长时间无进展时适当补充简短进度，完成后发送最终结果。',
    '- 需要补充群聊上下文时，使用以 "qqtool" 开头的工具查询本群历史。需要发送消息时，使用以 "qqbot" 开头的工具。',
    '- 向 QQ 群发送文字必须显式调用 qqbot_send_message，普通 assistant 文本（包括最终回复）不会公开到群聊。',
    '- qqbot_send_message 成功后，必须再原样输出 assistant 文本 "已发送"，然后再结束本轮，否则会报错！',
    '',
    '## 记忆管理',
    '- MEMORY.md 是经过整理的长期记忆，允许更新、合并和删除过时信息，保持内容准确、精简。',
    '- 每日日志采用追加式记录，已有内容不得静默修改或覆盖。',
    '- 发现历史记录错误或信息变化时，在当前日志追加更正说明，不修改原始记录。',
    '- SOUL.md 只在长期交流足以支持稳定人格调整时修改，避免因单次事件改变人格。',
    '- 每过一个月时，将上个月的日志整理，提炼有长期价值的信息并更新 MEMORY.md。',
    '- 完成整理后，调用 qqtool_archive_group_logs 工具，将对应月份的日志归档为 memory/YYYY-MM.zip。',
    '- ZIP 归档作为历史记录保留，不随意修改或覆盖。',
    '',
    '## 文件与安全',
    '- 文件操作只允许在本群 workspace 内进行。',
    '- 不覆盖或随意改写历史日志。',
    '- 外部操作、公开发布及代表群友作出的承诺必须谨慎处理。',
  ].join('\n');
}

// tools_of_history 的工具提示词
const historyToolPrompts = {
  qqtool_get_recent_messages: '读取当前群最近消息，按时间正序；cursor 沿用返回的 next_cursor 继续向前翻页。',
  qqtool_search_messages: '当前群按北京时间、账号或昵称、字面关键词组合检索（条件为 AND）；cursor 翻页。',
  qqtool_get_message_context: '展开当前群某条消息的前后文；before/after 为 1~32。',
  qqtool_get_message: '完整读取单条消息，展开折叠长文本；缺失的图片、附件、语音只给元数据与缺失标记。',
};

// 允许 bot 使用的工具（白名单的默认值）
const DEFAULT_TOOLS_ALLOWLIST = [
  "qqbot_send_file",
  "read", "write", "edit",
  "glob", "grep", "pwsh",
  "web_fetch", "web_search"
];


// 无用的 section 提示词，移除以节约 token 消耗。
const SECTIONS_TO_DROP = [
  'context:file-reference',          // 本地文件引用指引
  'harness:source',                  // 开发态源码 checkout 说明
  'app:web-surface',                 // Web GUI URL 说明
  'web-runtime',                     // Web 运行时说明（旧版遗留，防版本回退）
  'ui:deliverable-file-references',  // Web 文件卡片长指引
  'deployment:persona-prefix',       // 部署编码人格前缀
  'deployment:persona-suffix',       // 部署编码人格后缀
  'subagent:delegation',             // 子代理委托说明
  'tools:ptc-only',                  // PTC 独占说明
  'tools:sdk',                       // 生成 SDK 说明
];

// 无用的 context 提示词，移除以节约 token 消耗。
const CONTEXTS_TO_DROP = [
  'harness:source',
  'app:web-surface'
];

// 要压缩的 context 提示词，压缩为中文短句，未知格式原样保留。
const CONTEXT_TO_COMPACT: Record<string, (text: string) => string> = {
  'working-directory:current': (text) => {
    const m = /^Current working directory:\s*(.+?)(?:\r?\n|$)/m.exec(text);
    return m ? `实际 cwd：${m[1].replace(/\.\s*$/, '')}` : text;
  },
  'sandbox:policy': (text) => {
    const mode = /^Current DSH file policy:\s*([\w-]+)\./m.exec(text);
    const root = /session workspace:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    return mode ? `文件权限：${mode[1]}${root?.[1] ? `；范围：${root[1]}` : ''}` : text;
  },
  'approval:policy': (text) => {
    const mode = /^Approval policy:\s*([\w-]+)\./m.exec(text);
    return mode ? `审批：${mode[1]}` : text;
  },
};


export { CONTEXTS_TO_DROP, CONTEXT_TO_COMPACT, DEFAULT_TOOLS_ALLOWLIST, SECTIONS_TO_DROP, historyToolPrompts, systemPromptBuilder, workDir };
