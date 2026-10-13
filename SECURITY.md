# Security Policy

## Supported versions

安全修复优先应用到最新的 `0.1.x` 版本。发布新 minor 版本后，旧 minor
版本不保证继续获得修复。

## Reporting a vulnerability

请使用仓库的 **Security → Report a vulnerability** 私密报告入口，不要创建公开
Issue。

报告请包含：

- 受影响版本与运行环境
- 可复现步骤或最小复现仓库
- 影响范围
- 已知缓解方式
- 如适用，建议的修复方向

维护者会尽快确认报告，在修复发布前协调披露时间。

## Security boundaries

- Cursor/MCP 工具审批是用户授权边界。
- 成员 `toolPolicy` 仅限制模型可见工具，不是操作系统沙箱。
- 写成员会修改目标工作区；默认仅保证同一进程内写任务串行。
- 不支持多个 MCP 进程并发写入同一个 `.cursor-agent-teams` 状态目录。
- Dashboard 默认只监听 `127.0.0.1`，不应直接暴露到公网。
- Cursor API Key 和 SDK 登录凭据不应写入团队状态或提交到仓库。
