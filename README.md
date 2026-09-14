<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 守护运行时底座——运行时环境发现（bin/profile/port/baseUrl/dshHome/workspace 单一来源）+ webman 进程管理（spawnWeb/killWeb/portOwnerPid/isDshWebProcess/portInUse/waitPortFree）；消除 sentinel/guardian/preflight 各自重复发现环境
  inject: （无）—— 本插件是被依赖的底座，不消费其它服务；通过 ctx.provide('agentRuntime') 与 ctx.provide('webman') 对外暴露
  tools: （无）
  runtime: host-only
  envDeps: Node ≥ 22（spawn 自身 execPath）· Windows：`netstat -ano` 与 `powershell Get-CimInstance`（端口归属/进程身份判定）· 非 Windows 走 `process.kill` 兜底 · DSH_HOME 可写（web 日志与事件日志）
  boundary: 提供事实与进程原语，**不决定何时重启/拉起**（那是 sentinel/guardian）；不持有生命周期所有权（单点所有权纪律）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1
-->
# dsh-agent-runtime

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-runtime"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-22%20passed-brightgreen" alt="tests">
</p>

**一句话**：守护体系的**事实来源层**——一处发现运行时环境（bin / profile / port / `DSH_HOME` / workspace），一处提供进程原语（拉起 / 停止 / 查端口归属 / 判进程身份）。

**为什么值得用**：守护类插件最危险的 bug 是**认知分裂**——sentinel 认为端口是 X、guardian 认为是 Y，于是一个在杀「它以为的旧实例」，另一个在拉「它以为的新实例」，最后跑出两个 web。把「环境是什么」收敛成**唯一来源**，把「这个 pid 是不是我们的 web」「这个端口谁占着」这种**判错了会误杀进程**的判定从各插件闭包里抽出来集中实现并离线单测，是这套体系能安全自愈的前提。

## 能力

本插件**不注册任何工具**，它对外提供两个 cordis 服务：

### `ctx.agentRuntime`（RuntimeService · 环境事实）

| 成员 | 说明 |
|------|------|
| `bin` | `dsh bin.js` 绝对路径（源码安装自动发现；**空串 = 未发现**，调用方必须响亮处理） |
| `profile` / `port` / `baseUrl` | 守护目标 profile、web 端口、web API 基址 |
| `dshHome` / `workspace` | `DSH_HOME` 与默认工作区 |
| `launchCmd` | web 启动命令数组（**按当前 bin 现算**，不是一次性快照；bin 未发现 → 空数组） |
| `resolve()` | 重解析环境（bin 文件变化后调用；bin 变了会随之重算启动命令并记一条日志） |

**bin 发现顺序**（决策在 `src/pure.ts`，IO 留在 `index.ts`）：

1. 显式配置 `config.bin`（**即使该路径不存在也照用**——显式配置即权威）；
2. 当前进程 `process.argv[1]`（以 `bin.js` 结尾且存在）——源码安装时守护进程本身就是 dsh，跟随自身最可靠；
3. `binCandidates(dshHome)` 兜底候选（`DSH_HOME` 下的源码位置 → 已知 checkout 位置），按顺序取第一个存在的；
4. 都不匹配 → **空串**（明确「未发现」，绝不静默造一个默认值）。

**默认启动命令**：`[execPath, --expose-internals, <bin>, --profile, <profile>, --no-open]`；配了 `launchCmd` 则原样优先使用。

### `ctx.webman`（WebmanService · 进程原语）

| 方法 | 说明 |
|------|------|
| `spawnWeb(workspace, onExit?)` | 拉起 web，返回子进程（可 kill/跟踪）；`onExit(code, signal)` 在退出时回调。**返回 `null`** = 拉不起来（启动命令为空 / spawn 抛错），此时必须当失败处理 |
| `killWeb(pid)` | 结束进程（Windows：`taskkill /T /F /PID`；其他平台 `process.kill`），随后 12 × 500ms 轮询确认 PID 真的消失，返回是否确认死亡 |
| `portOwnerPid()` | `netstat -ano` 解析占用 `127.0.0.1:<port>` 且 **LISTENING** 的 pid；找不到 → `null` |
| `isDshWebProcess(pid)` | 该 pid 的命令行是不是「我们的 dsh web」（守护据此决定杀 / 不杀） |
| `portInUse(port?)` | TCP 连一次判端口是否被监听 |
| `waitPortFree(maxWaitMs?)` | 轮询直到端口空闲（默认上限 300000ms），超时返回 `false` |

`spawnWeb` 的行为细节（源码语义）：`cwd` = 传入 workspace，`stdio` 全 `pipe`，子进程 stdout/stderr 会**同时转发到本进程 stderr + 落盘**；env 注入 `NODE_USE_ENV_PROXY=1`；仅当命令首项是 `npx` 时启用 `shell`。子进程 stdout 中匹配到 `dsh web: <url>` 时，会把该 URL 写入 `<DSH_HOME>/.web-url`（供登录脚本读取）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-runtime": "link:<工作区>/self-plugins/dsh-agent-runtime"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-runtime && npm install && npm run build && npm test
```

**3) 挂组合**（**必须早于**消费它的守护插件——它提供的是底座服务）：

```yaml
- id: agent-runtime
  name: dsh-agent-runtime
  config:
    profile: web
    port: 3080
```

**4) 30 秒验证**：

```bash
tail -1 "$DSH_HOME/.watch-events.log"
# 期望：最后一行是 `[<ISO>] runtime 就绪 v5（HMR 实测轮次3）`
```

（本插件无工具可调；更强的验证见下一节的「三选一判据」。）

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `bin` | `''`（自动发现） | `dsh bin.js` 绝对路径；显式配置优先且**不做存在性校验** |
| `profile` | `web` | 守护目标 profile（决定默认启动命令里的 `--profile`） |
| `port` | `3080` | web 端口（`portOwnerPid` / `portInUse` / `waitPortFree` 的目标） |
| `baseUrl` | `http://127.0.0.1:3080` | web API 基址（供消费方探活） |
| `dshHome` | `$DSH_HOME`（空串则回退进程 cwd） | `DSH_HOME`：日志、`.web-url`、bin 兜底候选的根 |
| `defaultWorkspace` | `''`（回退进程 cwd） | 默认工作区 |
| `launchCmd` | `[]` | 显式启动命令数组；非空则**原样**使用，不走默认模板 |

## 落盘与自证（出问题时先看这里）

本插件**不写阶段轨迹（无 `*-trace.jsonl`、无阶段枚举）**——它是底座，产出的证据在**进程与日志面**：

| 文件 | 内容 |
|------|------|
| `<DSH_HOME>/.watch-web.log` | web 子进程 stdout/stderr 落盘。行格式 `[<ISO 时间戳> out\|err] <chunk>`。**有界**：文件超过 2MB 时截掉一半再继续追加（防止崩溃循环把磁盘写满） |
| `<DSH_HOME>/.watch-events.log` | 关键事件行（append）。目前两类：插件就绪（`runtime 就绪 v5（HMR 实测轮次3）`）、web 认证 URL 已捕获 |
| `<DSH_HOME>/.web-url` | web 启动时打印的带 token 认证 URL（最新一次覆盖写） |

**一条命令答五问**：

```bash
tail -20 "$DSH_HOME/.watch-events.log"; echo ---; tail -5 "$DSH_HOME/.watch-web.log"
# ① 跑的是哪个构建  → 事件行文案自带版本指纹（`runtime 就绪 v5（HMR 实测轮次3）`）；更可靠的是比 lib/index.js 的 mtime 与进程启动时间
# ② 谁发起          → 取不到 caller（本插件不记调用者）；spawn 由 sentinel/guardian 触发，用进程树与消费方日志回溯
# ③ 断在哪一段      → 事件日志**末尾没有就绪行** = 插件没装载；`.watch-web.log` 有 web 的启动栈/退出 = 子进程起来了但自己崩了；`bin` 未发现时宿主 logger 报「web 启动命令为空」
# ④ 结果质量        → `.web-url` 有没有被更新（捕获到认证 URL = web 真起来了）；`spawnWeb` 返回 null 即「没拉起来」
# ⑤ 耗时与预算      → 无 durationMs 字段；预算语义在代码常量里：`killWeb` 确认窗口 12×500ms、`waitPortFree` 默认上限 300000ms、`netstat` 超时 5000ms、`powershell` 超时 8000ms
```

观测纪律：日志写入一律**吞错**（父路径是普通文件、磁盘满都不抛、不影响 spawn 流回调），并配有尸体测试；日志有界（>2MB 截半），**不会**因为长期运行把磁盘写满。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. 行为级（最直接）：消费方能拿到 `ctx.agentRuntime.bin` 且**非空**、`ctx.webman.portOwnerPid()` 能返回端口归属 ⇒ 服务已装载且发现链工作正常；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 进程在跑它；
3. 事件级：`tail -1 "$DSH_HOME/.watch-events.log"` 出现 `runtime 就绪 v5`，且该行时间戳**晚于** `lib/index.js` 的 mtime ⇒ 当前进程加载的是这个产物。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。提供底座服务的这一侧（watch）**没有** `hasUnverifiedBuilds()` 类兜底，构建完必须重启该进程。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-runtime revert <commit>` → `npm run build` → `npm test` → 预检 → 重启；
- 组合级：在 profile 给 `agent-runtime` 行加 `disabled: true` 前，**先确认没有消费方依赖它**（sentinel / guardian / preflight 会因服务缺失而报 `cannot get property ... without inject` 或启动失败）→ 再重启；
- 运行期：无需回退（无持久业务状态；`.watch-web.log` / `.watch-events.log` / `.web-url` 均可随时删除，只影响取证）。

> **部署边界（守护族硬约束）**：本插件挂在 **watch profile**（守护侧），而 **watch 侧的更新与重启由主人执行**——改代码、构建、跑测试、出报告都归开发者；**kill / 重启守护进程不归开发者**（守护链是最后一道托底，自己把自己杀掉会让整个体系在无人接管时停摆）。构建完成 + 测试通过即可交付，重启等主人。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**22 例离线测试全部通过**（`# pass 22 / # fail 0`）：

| 文件 | 覆盖 |
|------|------|
| `tests/pure.test.mjs` | 纯决策层：`binCandidates`（顺序固定；`dshHome` 空串回落 cwd 且不产出相对路径）、`discoverBin`（config 覆盖优先——路径不存在也照用；跟随 `argv[1]`；`argv[1]` 非 `bin.js`/不存在 → 走兜底；候选全不存在 → **空串**，未发现必须可辨识；兜底按顺序取第一个存在的）、`buildLaunchCmd`（显式配置优先且**返回拷贝**；正常路径 `[execPath, --expose-internals, bin, --profile, <profile>, --no-open]`；**bin 未发现 → 空数组**，不拼一条必然失败的命令）、`parsePortOwner`（取 LISTENING 行 pid；空输出/无匹配/端口不符/非 LISTENING/畸形 pid → `null`；**「不知道」与「知道」可区分**——`null` 与 `0` 不得混淆）、`isDshWebCommandLine`（bin.js + web profile / `@deepseek-ai/dsh` 判是；空输出/无关进程/非 web profile 判否；**文档化 quirk**——`bin\.js` 是子串匹配，`mybin.js` 也算，语义故意未收紧） |
| `tests/contract.test.mjs` | 契约与仓库卫生：入口导出 `name`/`inject`/`apply` 且 `inject` 为空（底座不消费其它服务）；**启动命令现算**——`apply` 顶层不得出现 `const launchCmd =` 快照、`launchCmd` getter 必须经 `launchFor(bin)`；**尸体样本**（修前的顶层快照写法必须被检测器抓到）；观测不反噬（坏路径不抛、正常路径落一行带时间戳与流向、日志有界 >2MB 截半）；tests 目录不残留临时夹具 |

**无网络依赖、无真实外部服务依赖**：需要 Windows 命令（`netstat` / `powershell`）的路径由纯函数以**文本样本**覆盖，不真跑进程；`spawn`/`kill` 只在生产路径上发生。

## 设计要点

- **决策与 IO 分离是硬约束**：`pure.ts` 里全是纯函数，`index.ts` 只做 IO（`existsSync` / `execFile` / `spawn`）。原因不是洁癖——这些判定**判错了会误杀进程或拉起重复 web**，必须能离线验证。改动时**不得把判定塞回 `apply()` 闭包**（`contract.test.mjs` 会用检测器抓这种回退）。
- **「未发现」必须响亮**：`bin` 未发现返回**空串**，`launchCmd` 随之是**空数组**，`spawnWeb` 立刻返回 `null` 并记 error。绝不「猜一个默认路径」——拼一条必然失败的命令会掩盖真因，让排障从「bin 没找到」变成「web 起不来的谜案」。
- **启动命令必须现算**：`launchCmd` 是 getter，每次经 `launchFor(bin)` 计算。曾经的实现是 apply 顶层一次性快照：`resolve()` 更新了 `bin`，但 bin 从「未发现」变为「已发现」时启动命令仍是空数组 → `spawnWeb` 报「启动命令为空」→ **保活静默失效**。这条是**保活链路的活性不变量**。
- **`null` ≠ `0`**：`portOwnerPid()` 返回 `null` 表示「不知道谁占着端口」，「知道」才返回 pid。把「不知道」压成 `0`（或反之）会让守护误判「端口空闲」→ 拉起第二个实例（单点所有权事故的常见形状）。
- **进程身份判定故意不收紧**：`isDshWebCommandLine` 用子串匹配（`bin\.js` 会匹配 `mybin.js`）。收紧词边界会让**真 web 判不出来** → 守护以为端口空闲 → 拉起重复 web——这比误杀更常见。语义变更必须与 sentinel / guardian 一起定调（见 `docs/semantic.md` §10 未决问题）。
- **本插件不是 owner**：它提供原语与事实，但**生命周期所有权归消费方**。同一资源的保活/拉起者只能有一个（多于一个时必须定义交接协议，否则会出现「一次重部署触发两次重启 + 两条唤醒」）。
- **日志有界 + 吞错**：`writeWebLog` 超 2MB 截半、任何写失败都不抛。观测层永远不能反噬被观测的主流程。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题（含「进程身份判定是否收紧」） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `guardian-lifecycle` / `guardian-robustness-audit` / `preventive-lifecycle` | 守护型进程的安全替换、守护链健壮性审计清单、预防性存活 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
