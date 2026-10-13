# Cursor Agent Teams

[![CI](https://github.com/TiTi-xu912/cursor-agent-teams/actions/workflows/ci.yml/badge.svg)](https://github.com/TiTi-xu912/cursor-agent-teams/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-2f6f5e.svg)](LICENSE)

Cursor 可用的持久化多智能体协作系统。它将 Cursor Plugin、Cursor SDK、
MCP、Subagents、Skills、Rules 和 Hooks 组合成一个可恢复的团队调度层。

## 已实现

- 队长、角色成员与每成员模型/工具策略
- 草案审查后启动
- 任务依赖 DAG 与自动调度
- 只读任务并行、写任务串行防冲突
- Cursor SDK 持久 Agent ID 与中断恢复
- 单调 attempt ID，拒绝迟到结果
- JSON 状态、JSONL 事件与成员邮箱
- requirements / implementation / verification / review / repair /
  integration 质量合同
- 审查失败后的自动修复与复审
- 停止、恢复、重派和归档
- 14 个 MCP 工具及状态 resource
- 项目级 Cursor Agents、Skill、Rule、Command 和 Hooks
- 本地只读状态 Dashboard

## 运行要求

- Node.js `>=22.13`
- Cursor Desktop 或 Cursor CLI
- Cursor SDK 登录，或 `CURSOR_API_KEY`

## 从源码快速启用

```powershell
git clone https://github.com/TiTi-xu912/cursor-agent-teams.git
cd cursor-agent-teams
npm ci
npm run build
node dist/src/cli.js login
npm run install:plugin -- --project .
```

然后用 Cursor 打开当前目录并重载窗口。项目级配置将位于：

```text
.cursor/
├── agents/
├── commands/
├── hooks.json
├── mcp.json
├── rules/
└── skills/
```

在聊天框输入：

```text
/agent-teams 审查这个项目的调度器，并从正确性、恢复能力和测试覆盖三个角度给出合并报告
```

也可以直接要求：

```text
用 Agent Teams 实现一个功能，先展示团队和任务依赖计划，确认后再运行。
```

## 安装到其他项目

先构建本项目，再将 Cursor 资产和 MCP 配置合并到目标项目：

```powershell
cd cursor-agent-teams
npm run build
npm run install:plugin -- --project C:\path\to\your-project
```

安装脚本会保留目标项目现有的 MCP server 和 Hooks，并追加
`cursor-agent-teams` 配置。生成的 MCP 配置直接指向本目录构建产物，因此不要在
安装后移动本目录；移动后重新执行安装命令。

## 安装为本地 Cursor Plugin

本地插件适合跨多个项目使用：

```powershell
cd cursor-agent-teams
npm run build
npm install -g .
npm run install:plugin
```

脚本会安装到：

```text
%USERPROFILE%\.cursor\plugins\local\cursor-agent-teams
```

随后执行 `Developer: Reload Window`。企业策略可能禁止 Local Plugin Imports。

npm 包发布后，也可以直接安装 CLI：

```powershell
npm install --global cursor-agent-teams
cursor-agent-teams auth-status
```

然后从源码仓库或 GitHub Release 获取插件目录，安装到 Cursor 的本地插件目录。

## 身份验证与模型

浏览器登录：

```powershell
node dist/src/cli.js login
node dist/src/cli.js auth-status
node dist/src/cli.js models
```

无自动浏览器环境可使用：

```powershell
node dist/src/cli.js login --no-browser
```

或在目标项目 `.env` 中配置：

```dotenv
CURSOR_API_KEY=cursor_xxx
CURSOR_MODEL=auto
```

常用配置：

```dotenv
CURSOR_AGENT_TEAMS_MAX_MEMBERS=8
CURSOR_AGENT_TEAMS_MAX_REPAIR_ROUNDS=2
CURSOR_AGENT_TEAMS_DASHBOARD_PORT=43117
CURSOR_AGENT_TEAMS_LOAD_SETTINGS=0
CURSOR_AGENT_TEAMS_ALLOW_NESTED=0
```

默认不会加载用户级 Cursor 设置，仅成员明确需要时加载项目、插件和团队设置。
默认禁止成员创建嵌套 Agent。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `agent_teams_list` | 列出团队 |
| `agent_teams_create` | 创建草案 |
| `agent_teams_add_member` | 添加成员 |
| `agent_teams_create_task` | 创建依赖任务 |
| `agent_teams_approve` | 批准并启动调度 |
| `agent_teams_status` | 查看完整状态 |
| `agent_teams_recover` | 冷启动安全恢复 |
| `agent_teams_reassign_task` | 撤销旧 attempt 并重派 |
| `agent_teams_send_message` | 写入持久邮箱 |
| `agent_teams_read_messages` | 读取邮箱 |
| `agent_teams_halt` | 停止整队 |
| `agent_teams_resume` | 恢复团队 |
| `agent_teams_archive` | 归档团队 |
| `agent_teams_dashboard` | 返回状态面板 URL |

## 状态目录

每个目标工作区使用：

```text
<workspace>/.cursor-agent-teams/
├── teams/<team-id>/
│   ├── team.json
│   ├── events.jsonl
│   └── inbox/<recipient>.jsonl
├── archive/<team-id>/
└── cursor-hooks.jsonl
```

状态写入使用临时文件加原子重命名。同一服务进程内按团队串行更新；不要同时启动
多个 MCP 进程操作同一个工作区状态目录。

## Dashboard

通过 MCP 工具 `agent_teams_dashboard` 启动，或单独运行：

```powershell
node dist/src/cli.js dashboard --workspace C:\path\to\project --port 43117
```

面板为只读状态投影。Cursor 官方目前没有公开稳定的 MCP Apps TypeScript UI
resource 注册 API，因此没有伪造原生 Agents Window 插槽；未来可在不改变核心调度层
的情况下增加 MCP App 展示适配器。

## 开发验证

```powershell
npm run typecheck
npm test
npm run build
npm run verify
node dist/src/cli.js doctor --workspace .
npm run smoke:live
```

`smoke:live` 会创建一支只读团队，实际调用 Cursor SDK 阅读本项目文档，等待任务
完成后归档团队；该命令会产生一次真实模型调用。

## 安全说明

- MCP 的 approve、重派、停止工具会启动或取消 Cursor SDK 执行，应保留 Cursor
  的工具审批策略。
- `toolPolicy` 控制模型可见工具，不是操作系统沙箱。
- 写成员会直接修改目标工作区。调度器默认串行写成员，防止并行写入相互覆盖。
- Dashboard 只绑定 `127.0.0.1`，不要改成公网地址。
- `.env` 已被 `.gitignore` 排除，不要提交 API Key。

## 上游与许可证

本项目受
[`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)
启发，并保留其 MIT 版权声明。Cursor 宿主适配层为独立实现，详见
`NOTICE.md` 和 `LICENSE`。

## 参与贡献

- 贡献流程：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- 安全报告：[`SECURITY.md`](SECURITY.md)
- 版本记录：[`CHANGELOG.md`](CHANGELOG.md)
- 发布流程：[`docs/releasing.md`](docs/releasing.md)

提交公开 Issue 或日志前，请删除 API Key、邮箱和本机敏感路径。
