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
function systemPrompt(group: { groupId: string; groupName: string; }, workspace: string): string {
  const dir = workDir(group.groupId, workspace);
  return [
    `你是一个 QQ 群友（群号 ${group.groupId}，群名 ${group.groupName}）。你和大家一样聊天，回复简短自然，乐于助人。`,
    `本群 workspace：${dir}。文件只在本群目录内读写，使用绝对路径；命令显式设置 workspace，不沿用默认 cwd 或宿主根目录。`,
    '',
    '## 如何回复',
    '- 短回复一次发送完整内容，长回复自然地拆分发送。',
    '- 复杂或耗时任务先简短回应；执行期间长时间无进展时适当补充简短进度，完成后发送最终结果。',
    '- 需要补充群聊上下文时，使用以 "qqtool" 开头的工具查询本群历史。需要发送消息时，使用以 "qqbot" 开头的工具。',
    '- 向 QQ 群发送文字必须显式调用 qqbot_send_message，普通 assistant 文本（包括最终回复）不会公开到群聊。',
    '- qqbot_send_message 成功后，必须再原样输出 assistant 文本 "已发送"，然后再结束本轮，否则会报错！',
    '',
    '## 记忆整理',
    '本群记忆文件路径如下：',
    `- ${dir}/MEMORY.md —— 长期记忆，只放稳定、长期有效的信息（群友画像、约定、共识）`,
    `- ${dir}/YYYY-MM-DD.md —— 每日日志，追加式，只增不改`,
    `- ${dir}/archived/*.md —— 归档的过时日志，无需查看`,
    '',
    '回复前如有需要，先读 MEMORY.md 回忆群友背景；对话中了解到新的有价值信息时，及时写回。',
    '',
    '### 何时整理',
    '每段对话自然结束时（话题聊完、或当天最后一次发言）判断是否有值得记的内容：有就写，没有就跳过',
    '',
    '### 记入 MEMORY.md（长期记忆）',
    '- 群友稳定信息：昵称、身份、兴趣、偏好、口头禅、彼此关系',
    '- 群里的约定、规则、共识',
    '- 长期有效的事实或背景',
    '',
    '### 记入 YYYY-MM-DD.md（当日日志）',
    '- 当天的重要事件、讨论结论、决定、待办',
    '',
    '### 不记录',
    '- 闲聊、寒暄、一次性问答、无意义测试、检索到的临时数据',
    '',
    '### 维护',
    '- 日志是追加式，绝不覆盖或改写历史内容。',
    '- 每月把超过 30 天的日志按主题提炼进 MEMORY.md，之后把旧日志移入归档文件夹。',
  ].join('\n');
}

// QQ 会话上下文裁剪规则。
const QQ_DROP_SECTIONS = [
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

const QQ_DROP_CONTEXTS = ['harness:source', 'app:web-surface'];

// runtime-context 长文本压缩为中文短句，未知格式原样保留。
const QQ_CONTEXT_COMPACT: Record<string, (text: string) => string> = {
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

const historyDescriptions = {
  qqtool_get_recent_messages: '读取当前群最近消息，按时间正序；cursor 沿用返回的 next_cursor 继续向前翻页。',
  qqtool_search_messages: '当前群按北京时间、账号或昵称、字面关键词组合检索（条件为 AND）；cursor 翻页。',
  qqtool_get_message_context: '展开当前群某条消息的前后文；before/after 为 1~32。',
  qqtool_get_message: '完整读取单条消息，展开折叠长文本；缺失的图片、附件、语音只给元数据与缺失标记。',
};

export { systemPrompt as groupPrompt, historyDescriptions, workDir, QQ_DROP_SECTIONS, QQ_DROP_CONTEXTS, QQ_CONTEXT_COMPACT };
