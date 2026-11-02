# 本地工作区（fork 专用）

本目录是本 fork 相对上游 `deepseek-ai/dsh-superagent-prototype` 增加的材料。上游代码保留在仓库根目录，本目录只放二次开发的产物。

## 内容

| 路径 | 说明 |
| --- | --- |
| `docs/evaluation.md` | 可行性评估与优化路线：逐模块复用度、实测技术债清单、优化优先级、分阶段验收标准 |
| `docs/windows-patches.md` | 本地适配补丁逐条说明（症状 / 根因 / 改法）、升级 SOP、故障速查 |
| `patches/dsh-superagent-windows-host.patch` | 可重放补丁：对干净上游 `git apply` 校验通过 |
| `scripts/diagnose.mjs` | 一键诊断：采集 fork 状态、profile、state 目录、端口、API、插件日志，并给出结论 |
| `scripts/supervisor.mjs` | 进程守护：直接持有 DSH 宿主进程，负责启动、崩溃自愈、停止与锁清理（替代依赖 tmux 的官方脚本） |
| `scripts/verify-restart-survival.mjs` | 验收脚本：验证管理 API 在配置保存引发的 fiber 重启前后始终可用 |

## 运维命令

```bash
# 启动（后台守护）/ 停止 / 状态
node local/scripts/supervisor.mjs start --detach
node local/scripts/supervisor.mjs stop
node local/scripts/supervisor.mjs status

# 诊断（服务停着也能跑）
node local/scripts/diagnose.mjs                 # 打印并写入 ~/.dsh/state/superagent-diagnosis.txt

# 验证配置保存不会打掉管理 API
node local/scripts/verify-restart-survival.mjs
```

## 与上游的关系

上游是 DeepSeek Harness 团队开源的**研究原型**（MIT），非官方产品，README 自陈 "research prototype, not production-ready"。本 fork 的改动分两类：

1. **Windows / 宿主契约适配**（本机 DSH 0.2.1-rc.5 上验证通过）
2. **上游缺陷修复**（删除 issue 导致 GitHub 源持续报错 24 小时）

全部改动在 `feature/windows-host-adaptation` 分支上，逐条说明见 `docs/windows-patches.md`。

## 快速开始（Windows）

```bash
pnpm install --offline && pnpm build
# 用 DSH 加载本仓库为 bundle
dsh plugin --profile <你的profile> add "link:<本仓库路径>"
```

本机已用 `superagent` profile（端口 3082）跑通完整闭环：GitHub 评论 → 工单 → 独立 worker 会话 → 在原会话回帖。

## 许可

上游为 MIT，保留其版权声明；本 fork 的改动沿用同一许可。
