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
| `scripts/dsh-superagent-config.mjs` | 配置写入：GitHub 源、本地目录源、webhook 源、策略白名单与执行器设置（prepare 走 ghfast.top 镜像取代码） |
| `scripts/verify-restart-survival.mjs` | 验收脚本：验证管理 API 在配置保存引发的 fiber 重启前后始终可用 |

## 本机触发源与手动建单（本 fork 新增）

原型的触发源只有 GitHub 与飞书，且没有手动入口。本 fork 加了三种"不碰 GitHub 也能派活"的方式。

### 本地目录 Source

监视一个文件夹，放进去的文件就是请求，答案写在同名 `.reply.md` 旁。不需要账号、令牌、网络或任何外部程序。

```bash
# 1. 监视 C:/Users/26825/tasks（写入 source:localdir 与策略白名单）
node local/scripts/dsh-superagent-config.mjs source:localdir policy

# 2. 放一个请求进去
echo "把 README 的第一段翻译成英文" > C:/Users/26825/tasks/translate.md

# 3. 约 10 秒后面板出现工单，答案写在 C:/Users/26825/tasks/translate.reply.md
```

### 本地 Webhook Source

本机程序向回环端点 POST 一份请求即派活——IDE 任务、CI 步骤、脚本、计划任务都行：

```bash
curl -X POST -H "x-webhook-request: 1" -H "content-type: application/json"   -d '{"text":"跑一遍测试并把失败项列出来","key":"ci-42"}'   http://127.0.0.1:3082/orchestrator/webhook
```

- `x-webhook-request: 1` 头必须有：它让浏览器网页无法跨站触达端点（自定义头会触发预检，端点不应答预检）。
- `key` 可选：带上它，重发同 key 判 `duplicate`（幂等）；不带则每次 POST 都是新请求。
- 配置块 `source:webhook` 可设共享令牌（`x-webhook-token` 头，常量时间比较）。
- 应答 `202 {status, trigger_id, thread}`；`status` 是引擎的收件结果（`stored`/`duplicate`/`filtered`）。
- 工单结果没有回程通道：调用方轮询 `GET /orchestrator/api/tickets?state=open` 或看面板。
- 中文注意：从 Windows 命令行内联传中文会被本地代码页搞乱——把 JSON 写进 UTF-8 文件用 `--data-binary @file` 发。

实现见 `src/sources/webhook.ts`（bundle 插件 `./webhook-watch`）。

### 面板手动建单

执行页（Execution）有"新建工单"按钮：填一句话请求即建单并立即派发，等价于一条显式请求。程序化入口是管理 API：

```bash
curl -X POST -H "x-orchestrator-request: 1" -H "content-type: application/json"   -d '{"text":"把 README 的安装一节翻译成英文","title":"翻译 README"}'   http://127.0.0.1:3082/orchestrator/api/tickets
```

`title` 可选（默认取请求第一行）；工单的目录名从标题的英文词推导。操作者的准入身份是内置的 `manual` Source kind，其策略名单由同步机制始终保留 `operator`，无需配置。实现见 `src/app/manual.ts`。

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
