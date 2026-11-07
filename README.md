# DSH Snow Bot Frame

> [!TIP]
>
> *和其它 QQ 机器人方案的不同？*
>
> - 合规：走 **QQ 官方机器人接口**（`@tencent-connect/dsh-qqbot`），不是协议库 or 逆向登录，**无封号风险**。
> - 自用：定位**本地自用、快速搭建**：在自己电脑上跑起来当群友、做开发调试，暂不适合远程部署。
> - 节约：**省 Token** 是本插件的**核心思想**：裁剪无关提示词、按需读历史、懒加载媒体，而非堆功能。

让 DSH 成为 QQ 群里的一个「群友」：有独立人格和记忆、能读历史、能发消息，并且每个群互相隔离。

配合官方 QQ 机器人插件（`@tencent-connect/dsh-qqbot`）+ 本地消息库后端 Tulpa 使用。

本插件不新增 MCP Server，历史数据全部走 Tulpa 的认证 MCP 接口，且大幅优化了 Token 消耗！

---

## 解决何事？

| 痛点 | 做法 |
| --- | --- |
| 官方 dsh_qqbot 插件拿不到聊天历史，Bot 进群聊是「失忆」的 | 注入 `qqtool_*` 历史工具，按需读当前群近期消息、检索、展开上下文 |
| 官方插件会把模型输出的所有文本发到群里，什么都发，话多不可控 | 抑制官方自动发送，改由 `qqbot_send_message` 显式发送 |
| 官方插件给的 OpenID 和 QQ群号的映射关系被隐瞒，无法确认对应关系 | 根据发送的消息去 Tulpa 智能匹配，匹配成功后记入缓存，全过程自动，无需手动填写配对关系 |
| 官方插件多个群共用一个工作空间，一套人格、一份记忆，串味 | 每群一个独立工作目录（隔离），文件操作只允许在本群目录 |
| 官方插件的对话自动落到「未分组」，且不可整理 | 自动分类到「QQAgent」组，标题自动设置为群聊名称 |
| DSH 默认提示词里塞满「You are a coding agent」这类和群友身份打架的内容。最重要的是**浪费 token**！ | 裁掉无关 section、context，只留群友身份和工具说明 |

## 功能一览

### 群人格与记忆
每个群一个目录，`SOUL.md`（人格）+ `MEMORY.md`（长期记忆）+ `memory/YYYY-MM-DD.md`（每日日志）+ `memory/YYYY-MM.zip`（月度归档）。文件由 AI 按提示词规则自主维护，插件只负责「首次缺失时补建」：SOUL.md 从 `assets/SOUL.md` 复制模板、MEMORY.md 建空文件，之后都不覆盖。

- 首次识别出群时自动建目录，无需手动准备。
- 日志过多时自动按月份归档，并沉淀真正有用的记忆。

### Bot 读历史（4 个）
- `qqtool_get_recent_messages` — 最近 N 条，从旧到新，可翻页。
- `qqtool_search_messages` — 按时间 + 发送者 + 关键词组合筛选（AND），`sort` 取最新/最早。
- `qqtool_get_message_context` — 展开某条消息前后文。
- `qqtool_get_message` — 完整读单条，展开折叠长文本。

时间按北京时间解释，支持到秒（`YYYY-MM-DD HH:MM:SS`）。所有查询只覆盖 Tulpa 已导入且授权的数据，查不到 ≠ 不存在。

### Bot 看媒体（`qqtool_fetch_media`）
懒加载，模型需要「看到」内容时才调用：
- 图片：落地到群目录 `.media/`，返回本地路径，再用 DSH 的 `read_image` 读。
- 语音：走 Tulpa 本地转写，返回时长、文本、语言等。

历史消息里的媒体默认只给元数据（`kind` / `index`），不下载，避免过度拉取。

### Bot 发消息（`qqbot_send_message`）
assistant 文本、流式片段、工具结果**都不会**自动发到群里，只有通过这个工具才会被看见。单条超过 4500 字符会截断只发第一块，保证一次调用只发一条。

### 群配对（后台全自动进行）
openid → 群的映射靠「最近一条消息的时间戳 + 内容」去 Tulpa 匹配，学成后写入 `~/.dsh-snow-bot-frame/learned-groups.json`，之后永久命中缓存、不再查。首条消息会有一次延迟（等 Tulpa 刷新入库），第二句起正常。

## 配置

见 `cordis.patch.yml` + 插件配置面板：

| 字段 | 说明 |
| --- | --- |
| `workspace` | 群目录根，如 `E:/AgentGround/QQAgent`，每个群在 `workspace/groups/<群号>` 下 |
| `tulpaUrl` | Tulpa MCP 端点，默认 `http://127.0.0.1:18777/mcp`，仅支持本机 loopback |
| `tulpaBearer` | Tulpa 凭据，**必填**，缺失则插件加载失败 |
| `toolAllowlist` | 工具白名单（默认值见 `src/prompt.ts`），本插件的 `qqtool_*` / `qqbot_send_message` 不受此限制、始终可用 |
| `patchEnabled` | 源码 patch 开关 |

改配置后需重启 DSH 生效。面板可重置 Tulpa 设置 / 工具白名单 / 已配对群聊。

## 开发与发布

```bash
pnpm run check      # tsc 类型检查
pnpm run demo       # 本地冒烟（不碰真实 Tulpa）
pnpm run release    # 编译 → 打包 → 安装到 desktop profile
pnpm run pack-only  # 只打包不安装
```

源码在 `src/`（TypeScript），编译到 `dist/`，打包成 tgz 安装。改源码必须重新 release + 重启 DSH 才生效，直接改运行副本会在下次安装时被覆盖。

## 目录结构

| 位置 | 职责 |
| --- | --- |
| `src/index.ts` | 入口，编排执行顺序 |
| `src/runtime.ts` | 挂 agent 钩子、事件处理（提示词注入、工作目录、白名单、群学习） |
| `src/prompt.ts` | 群提示词、工具描述 table、裁剪规则 |
| `src/config_schema.ts` | 配置声明 |
| `src/group_resolver.ts` | 群自动配对（学习、缓存、落盘） |
| `src/tools_of_chat.ts` | 发送工具、抑制自动发送的 patch |
| `src/tools_of_history.ts` | 4 个历史查询工具 |
| `src/tools_of_media.ts` | 媒体懒加载（图片、语音转写） |
| `src/tools_of_memory.ts` | 群文件补建、日志归档 |
| `src/bridge/` | 外部系统对接（Tulpa MCP、dsh-qqbot 映射、配置路由、路径） |
| `src/common/` | 通用（裁剪、白名单、patch 工具、参数水合、消息净化） |

工具相关 prompt 统一在 `src/prompt.ts` 的 `toolPrompts`，实际定义在 `tools_of_*.ts` 的 `paramDefs`，运行时自动合并，两侧参数名不一致会直接报错。

---

## 易随版本更新失效的位置

本插件大量依赖「版本敏感」的外部接口，升级 DSH / dsh-qqbot / Tulpa 后，先看这里。

| 依赖点 | 位置 | 失效表现 | 修复方向 |
| --- | --- | --- | --- |
| **对 dsh-qqbot 的源码暴力补丁（3 处）** | `src/tools_of_chat.ts` | bot 又开始自动发 assistant 文本；`qqbot_send_message` 不可用 | 重核 `outbound.js`（route + routeStreamFrame）和 `bootstrap.js`（registerSendFileTool 锚点），更新 before/after。当前适配 `@tencent-connect/dsh-qqbot@0.5.5` |
| **DSH 事件名 / 服务名** | `src/runtime.ts` | 提示词不注入、工作目录不切换、白名单失效、群不学习 | 核对 `system-prompt/assemble`、`agent/created`、`agent/inbox/claimed`、`session/event`，以及 `ctx.get('workingDirectory')`、`agent.ctx.tools.restrict` |
| **DSH system prompt 段名** | `src/prompt.ts` 的 `SECTIONS_TO_DROP` / `CONTEXTS_TO_DROP` / `SECTIONS_TO_COMPACT` | DSH 升级后提示词里又冒出「You are a coding agent」等底噪 | 用 `~/.workbuddy/skills/dsh-asar-inspect` 重新定位 section/context 的精确 name |
| **Tulpa MCP 工具名 / 返回结构** | `src/bridge/tulpa.ts`、各 `tools_of_*.ts` | 历史查询、媒体获取、语音转写报错 | 核对 `query_communication_db`（SQL 查 `agent_messages`）、`read_conversation`、`get_context`、`read_message`、`find_people`、`transcribe_voice`、`read_image`、`list_groups` |
| **Tulpa 消息/语音数据结构** | `src/common/message_purifier.ts`、`src/tools_of_media.ts` | 语音识别不出、媒体 index 错位、图片 404 | 语音不走 `media[]`（在 `voice` 字段，content 占位 `[语音消息]`）；图片靠 `read_image` 取 base64，不是走 HTTP 下载 |
| **dsh-qqbot 会话映射文件** | `src/bridge/qqbot_prefs.ts`、`paths.ts` | openid 解析不出 → 群不学习、提示词不注入 | 核对 `~/.dsh-qqbot/model-prefs.json` 的 sessionKey 格式 `qqbot:<appId>:group:<openid>` |
| **schemastery 配置 schema** | `src/config_schema.ts` | 配置面板不显示条目、配置读不到 | 核对 `volatile()` 标记与字段名 |
| **Tulpa bot 消息入库白名单**（Tulpa 侧，非本插件） | `scripts/qq_message_types.py` 的 `CONTENT_SUBTYPES` | bot 自己发的消息查不到 | 需含子类型 `65`（见 SnowTulpaFix 脚本），改后要重新导入消息库 |

> 排查提示：`dbg()` 调试日志写到桌面 `dsh-snow-bot-frame.debug.log`。提示词注入成功、群学习成功、patch 应用都会有对应输出，先看日志能快速定位是「没挂上」还是「挂了但数据不对」。
