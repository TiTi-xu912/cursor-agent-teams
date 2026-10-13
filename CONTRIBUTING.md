# Contributing

感谢你参与 Cursor Agent Teams。

## 开始之前

- 先搜索现有 Issue，避免重复工作。
- Bug 修复可以直接提交 PR。
- 新协议、状态格式、MCP 工具或破坏性变更，请先创建 Issue 讨论。
- 安全问题不要创建公开 Issue，请按 `SECURITY.md` 报告。

## 本地开发

要求 Node.js `>=22.13`。

```bash
git clone https://github.com/TiTi-xu912/cursor-agent-teams.git
cd cursor-agent-teams
npm ci
npm run verify
```

常用命令：

```bash
npm run typecheck
npm test
npm run build
npm run dev:mcp
npm run dev:dashboard
```

`npm run smoke:live` 会产生真实 Cursor 模型调用，不是普通测试的前置条件。

## 变更要求

- 保持 TypeScript 严格类型检查通过。
- 状态变更必须保留 attempt 防迟到覆盖语义。
- 新增 MCP 工具时同步更新 README、Skill、Rule 和集成测试。
- 状态格式变更必须提升 schema 版本并提供迁移策略。
- 不要提交 `.env`、`.cursor/`、`.cursor-agent-teams/`、SDK 凭据或本机绝对路径。
- UI 变更需兼顾窄屏、键盘焦点和 `prefers-reduced-motion`。

## Pull Request

PR 应包含：

1. 问题与解决方式
2. 行为或兼容性变化
3. 测试证据
4. 文档变化
5. 如涉及 UI，附截图

提交前运行：

```bash
npm run verify
npm pack --dry-run
```

提交信息建议使用 Conventional Commits，例如：

```text
feat(scheduler): add bounded retry policy
fix(state): reject stale attempt completion
docs: clarify project installation
```
