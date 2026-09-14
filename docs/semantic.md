# dsh-agent-runtime · 语义文档（守护运行时服务）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-runtime（守护运行时服务 · runtime 环境发现 + webman 进程管理） |
| 主副本路径 | `self-plugins/dsh-agent-runtime/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-runtime/src/index.ts`（唯一源码；产物 `lib/index.js`、`lib/types/index.d.ts`）；组合行 `self-plugins/dsh-agent-runtime/cordis.patch.yml` |
| 版本 | 0.1.0（取自 `package.json`） |
| 状态 | draft |
| 作者 | 爱丽丝 |
| 日期 | 2026-09-14 |

## 1 · 定位与反定位

**这是什么**：守护体系的**事实来源层**——把「web 在哪、跑在哪个 profile/端口、怎么拉起/杀停/探测端口」从 sentinel、guardian 的重复实现中抽出，成为两个 cordis 服务：

- `ctx.agentRuntime`（RuntimeService）：环境发现 — bin / profile / port / baseUrl / dshHome / workspace / launchCmd；
- `ctx.webman`（WebmanService）：web 进程管理 — spawnWeb / killWeb / portOwnerPid / isDshWebProcess / portInUse / waitPortFree。

**这不是什么**（反定位）：

- 不是守护者：不保活、不重启、不预检、不告警、不唤醒、不做周期调度；只提供**能力**，何时调用归 sentinel / guardian。
- 不注册任何模型可见工具（工具数 = 0），无 CLI、无面板、无 HTTP 端点。
- 不持有状态机：无崩溃计数、无租约、无事故判定、无「谁该动手」的裁决（§5.19 单点所有权归消费者）。
- 不是 sandbox：能 kill 任意 PID，身份校验责任在调用方。

## 2 · 术语表

| 术语 | 定义（本插件内语义） |
|------|---------------------|
| runtime 环境事实 | bin / profile / port / baseUrl / dshHome / workspace / launchCmd 七项，由本插件单一发现 |
| bin | dsh CLI 入口 `bin.js` 绝对路径；源码安装跟随 `process.argv[1]`，`config.bin` 可覆盖 |
| webman | web 进程管理服务：spawnWeb / killWeb / portOwnerPid / isDshWebProcess / portInUse / waitPortFree |
| portOwner | `netstat -ano` 中 `127.0.0.1:<port>` 处于 `LISTENING` 的 PID（唯一解析口径） |
| dsh web 进程判据 | 进程 CommandLine 命中 `/bin\.js/` 且含独立词 `web`，或命中 `/@deepseek-ai\/dsh/` |
| 落盘产物 | `$DSH_HOME/.watch-web.log`（web 输出转存）、`.web-url`（带 token 认证 URL）、`.watch-events.log`（事件追加） |

## 3 · 概念模型

```
cordis（watch profile）─ insert id=agent-agent-runtime ─► dsh-agent-runtime.apply
        ├── ctx.provide('agentRuntime', runtime)   环境事实（发现 / 可重解析 bin）
        └── ctx.provide('webman',      webman)     web 进程管理原语
   sentinel（重启 kill→spawn） / guardian（保活·自愈·收养） ─► dsh web 进程（profile=web, port=3080）
```

不变量（可用一次测量判真假）：

- **I1 单一来源**：环境事实只在 `discoverBin()` 与 config 默认值处产生，消费者不得再各自 netstat 猜端口（已知例外见 U1）。
- **I2 服务 id 精确**：`agentRuntime` 与 `webman`（**不是** `runtime`）。
- **I3 提供者无依赖**：`export const inject = []`，apply 不依赖其他服务即可完成 provide。
- **I4 load 时快照**：除 `bin`（`resolve()` 可重解析）外，其余环境项在 apply 时确定、运行期不变（改这些须重启 watch）。
- **I5 观测不反噬**：`writeWebLog` 全包 try/catch，写盘失败不影响主流程。
- **I6 认证 URL 捕获**：子进程 stdout 出现 `dsh web: <url>` → 写 `.web-url` 并追加 `.watch-events.log`「web 认证 URL 已捕获」。

## 4 · 契约

### 4.1 服务面

| 成员 | 签名 | 语义 / 失败面 |
|------|------|---------------|
| `agentRuntime.bin` | `string` | 未发现为 `''`；`resolve()` 重新发现，变化时 `logger.info('bin 路径更新: ...')` |
| `agentRuntime.profile / port / baseUrl / dshHome / workspace / launchCmd` | 只读 getter | `launchCmd` 缺省 `[process.execPath,'--expose-internals',bin,'--profile',profile,'--no-open']`，bin 未发现时 `[]` |
| `webman.spawnWeb(workspace, onExit?)` | `Promise<ChildProcess \| null>` | cmd 为空 → `logger.error('web 启动命令为空（bin 未发现？）——检查 runtime.bin')` + `null`；spawn 抛错 → `null`；env 注入 `NODE_USE_ENV_PROXY=1`；`shell` 仅当 `cmd[0]==='npx'` |
| `webman.killWeb(pid)` | `Promise<boolean>` | win32 `taskkill /T /F /PID`，否则 `process.kill`；12×500ms 探测存活，消失 `true`、仍存活 `false` |
| `webman.portOwnerPid()` | `Promise<number \| null>` | `netstat -ano`（timeout 5000）按唯一口径解析；异常/未命中 → `null` |
| `webman.isDshWebProcess(pid)` | `Promise<boolean>` | `powershell -NoProfile Get-CimInstance Win32_Process -Filter 'ProcessId = <pid>'`（timeout 8000）读 CommandLine；异常 → `false` |
| `webman.portInUse(port?)` / `waitPortFree(maxWaitMs=300000)` | `Promise<boolean>` | `net.connect({host:'127.0.0.1'})`；`waitPortFree` 每 5000ms 轮询、超时 `false`（当前无消费者，见 U3） |

配置（schemastery `Config`；当前组合行 `config: {}` → 全默认）：`bin=''`、`profile='web'`、`port=3080`、`baseUrl='http://127.0.0.1:3080'`、`dshHome`（空则回落）、`defaultWorkspace=''`（空则 `process.cwd()`）、`launchCmd=[]`。`dshHome` 优先级：`config.dshHome` → `process.env.DSH_HOME` → `process.cwd()`。

### 4.3 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|--------|--------------------|------|
| cordis 组合 | `self-plugins/dsh-agent-runtime/cordis.patch.yml`（insert `id: agent-agent-runtime`，`name: dsh-agent-runtime`，`config: {}`） | watch profile 装载插件行时 |
| 本插件自身 | `self-plugins/dsh-agent-runtime/src/index.ts:apply` → `ctx.provide('agentRuntime', runtime)` | apply 期（load 一次） |
| 本插件自身 | `self-plugins/dsh-agent-runtime/src/index.ts:apply` → `ctx.provide('webman', webman)` | apply 期（load 一次） |
| 本插件自身 | `self-plugins/dsh-agent-runtime/src/index.ts:apply` → `ctx.effect(...)` 行「runtime 就绪 v5（HMR 实测轮次3）」 | apply 期（卸载时 dispose） |
| dsh-agent-sentinel | `self-plugins/dsh-agent-sentinel/src/index.ts:apply → restartWeb()`（解构 `ctx.webman.portInUse/killWeb/spawnWeb/portOwnerPid/isDshWebProcess`） | 哨兵被触发（热重载/重启授权）→ 预检通过 →「先判身份再 kill，随后 spawnWeb」 |
| dsh-agent-sentinel | `self-plugins/dsh-agent-sentinel/src/index.ts:apply → waitWebReady()` 调 `portInUse(ctx.agentRuntime.port)` | 重启后等待 web 就绪（端口通 + `/api/session/list` 可用） |
| dsh-agent-sentinel | `self-plugins/dsh-agent-sentinel/src/index.ts:apply → apiRpc()` / `authority` 读 `ctx.agentRuntime.baseUrl` 与 `.port` | 每次唤醒/列表/投递 RPC（`session/list`、`session/prompt`） |
| dsh-agent-guardian | `self-plugins/dsh-agent-guardian/src/index.ts:apply → spawnWeb()` 调 `ctx.webman.spawnWeb(workspace, onExit)` | 保活/崩溃自愈拉起 web 时（其后 `notifyWebReady()`） |
| dsh-agent-guardian | `self-plugins/dsh-agent-guardian/src/index.ts:apply → waitPortFree()`（本地带日志封装）调 `ctx.webman.portInUse(ctx.agentRuntime.port)` | 拉起前等待端口释放（300000ms 预算） |
| dsh-agent-guardian | `self-plugins/dsh-agent-guardian/src/index.ts:apply → onWebExit()` / `adoptExternalWeb()` 调 `portInUse/portOwnerPid/isDshWebProcess` | web 子进程退出时、周期巡检收养外部进程时 |
| 产物消费者 | `self-plugins/dsh-agent-watch/src/index.ts:webLogFile()`（`.watch-web.log`） | 守护侧读取 web 输出转存产物（诊断/告警） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`killWeb` 不校验目标身份（`taskkill /T /F` 可杀任意 PID）；身份判定归调用方（sentinel 先 `portOwnerPid()` + `isDshWebProcess()` 再决定接管）。
- **不越界清单**：不写凭据、不发网络告警、不改 profile patch、不做 git 操作、不主动重启（只给原语）。
- **失败面**：读失败（netstat/powershell 异常）→ `null`/`false` 静默降级；写失败 → 吞掉（I5）；`bin` 未发现 → `spawnWeb` 返 `null` 且不抛（消费者须判空，guardian 已判 `spawned !== null`）。
- **信任与隐私**：服务方法无鉴权（cordis 进程内服务），信任范围 = 同 profile 本地插件；`.web-url` 含 token，落盘于 `$DSH_HOME`，不得外传。

## 6 · 与既有机制的关系

- **sentinel / guardian（消费者）**：`inject = ['preflight','agentRuntime','webman']`；进程管理与环境发现全部委派本插件，自身保留状态机（租约/崩溃计数/唤醒/告警）。
- **dsh-agent-preflight（同批三插件）**：只做组合试运行预检——runtime 给事实、preflight 把关、sentinel 协调、guardian 保活。
- **dsh-agent-watch（旧单体）**：**仍自带重复实现**——`portInUse`（`src/index.ts:192`）、`taskkill`（`:461`）、`spawn` 拉起（`:572`）、`netstat` 占用者解析（`:748`）。「单一来源」目前只覆盖新三插件（SOUL §5.2：watch 重启归主人执行）→ U1。
- **共享观测通道**：`.watch-events.log` 由 runtime / sentinel / guardian / watch 共同追加；`.watch-web.log` 由 runtime 写入、watch 读取。规则对齐：SOUL §5.19（单点所有权）、§5.11（改代码后重启属组合变更）、§5.22（落盘自证优先于 logger）。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名 / 命令 / 日志行 / 落盘产物） | 状态 |
|---|-----------|-----------------------------------------|------|
| 1 | 挂载后 `ctx.agentRuntime` 与 `ctx.webman` 可被消费者注入成功 | `$DSH_HOME/.watch-events.log` 出现 `runtime 就绪 v5（HMR 实测轮次3）`；宿主启动日志无 `cannot get property ... without inject` | 待验收 |
| 2 | `inject` 为空数组，apply 不因缺服务抛错 | `src/index.ts:37`（`export const inject = [] as const`） | ✔ 静态已核对（源码逐字） |
| 3 | 服务 id 是 `agentRuntime` 而非 `runtime` | `src/index.ts:152`；消费者 `dsh-agent-sentinel/src/index.ts:86` | ✔ 静态已核对 |
| 4 | bin 未发现时 `spawnWeb` 返回 `null` 而不抛错 | 构造 `bin:''` 调 `ctx.webman.spawnWeb(ws)` 断言 `=== null` + 日志 `web 启动命令为空（bin 未发现？）` | 待验收 |
| 5 | 捕获 web 认证 URL 并落盘 | 重启 web 后 `.web-url` 匹配 `http://…?token=…`，`.watch-events.log` 追加 `web 认证 URL 已捕获` | 待验收 |
| 6 | `.watch-web.log` 超 2MB 时截半后继续追加 | `(Get-Item "$env:DSH_HOME\.watch-web.log").Length` 长跑后 ≤ 2MB 且持续增长 | 待验收 |
| 7 | `portOwnerPid()` 只认 `127.0.0.1:<port> … LISTENING` 行 | `netstat -ano \| findstr 3080` 的 PID 与返回值一致；端口空闲返回 `null` | 待验收 |
| 8 | `killWeb` 对已退出 PID 返回 `true`、对杀不掉的 PID ~6s 后返回 `false` | 对已退出 PID 调 `killWeb(pid)` 断言 `true`（`src/index.ts:199-203`） | 待验收 |
| 9 | 改 `port`/`profile` 后热重载不生效（须重启 watch） | patch 改 `port: 9999` → 热重载后 `ctx.agentRuntime.port` 仍为 3080（I4） | 待验收 |
| 10 | 落盘失败不反噬主流程 | `src/index.ts:33` / `:275` try/catch（不可写 dshHome → 不抛错） | ✔ 静态已核对（缺夹具，见 U5） |

## 8 · 与实现的关系

- **主实现**：`self-plugins/dsh-agent-runtime/src/index.ts`（278 行，唯一语义源）；产物 `lib/index.js`（`pnpm build` → `tsc -p tsconfig.json`）+ `lib/types/index.d.ts`。**同语义副本**：无第二份正文；消费者侧**手抄**服务接口类型（sentinel `:133/145`、guardian `:84/96`）而非 import 本包类型，须与本文件 §4.1 对齐（漂移风险 U4）。**本文件描述的是工作区版本**——HEAD（`a598eac`）之后的未提交改动引入了 `writeWebLog` / `.watch-web.log` 转存与 2MB 截半（`git diff -- src/index.ts`，15 增 2 删），该段语义（I5、§4.1 spawnWeb 行、验收 #6）尚未进版本库。
- **生效判据**（改了代码后怎么证明真生效，缺一不可）：① **构建指纹 vs 进程启动时间**——`lib/index.js` mtime 必须**早于** watch 进程启动时间（重建 ≠ 生效，SOUL §5.11 §6），命令：比对 `(Get-Item …\lib\index.js).LastWriteTime` 与 watch 进程 `StartTime`；② **落盘自证**——`.watch-events.log` 尾部出现 `runtime 就绪 v5（HMR 实测轮次3）` 且时间戳 ≥ 本次构建时间（logger.info 不落盘，这行是唯一「新代码被 load」的落盘证据）；③ **服务可答**——宿主启动无 `without inject` 报错、`ctx.agentRuntime.bin` 非空；④ **行为面**——重启一次 web 后 `.web-url` mtime 前进、`.watch-web.log` 有新字节。
- **回退**：① **git 回滚**——本仓库回滚到上一 commit → 重新 build → 重启 watch（重启归主人执行，SOUL §5.2）；② **`plugin_stop` 停用**——但消费者 inject 了本服务，单独停用会让 sentinel/guardian 注入失败，须**同时停用消费者**或一并回退组合行；③ **降级到旧单体** `dsh-agent-watch`（其自带完整进程管理实现，见 §6）。

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-02 三插件重构 D2（源码注释记）：进程管理与环境发现从 sentinel/guardian 抽出，本插件 v0.1.0 诞生
- 2026-09-14 写文档时现读源码发现三处不一致（未改代码，登记为 U1/U2/U3）：注释与实现的服务 id 漂移、`waitPortFree` 无消费者、旧单体 watch 未接入单一来源
- 2026-09-14 版本口径说明：工作区有未提交的 `src/index.ts` 改动（`.watch-web.log` 转存/截半），本文档按**工作区事实**书写，提交后 §8 版本口径需同步复核

## 10 · 未决问题

- **U1**：旧单体 `dsh-agent-watch` 仍自带 `portInUse`/`taskkill`/`spawn`/`netstat` 重复实现——接入 runtime 服务，还是标为遗留并冻结？「单一来源」边界需一次裁决。
- **U2**：`src/index.ts:15` 注释写消费者 `inject ['runtime','webman']`，实际服务 id 是 `agentRuntime`（消费者写 `['preflight','agentRuntime','webman']`）——注释漂移，待修。
- **U3**：`WebmanService.waitPortFree` 无消费者（sentinel 未调用；guardian 用自己带日志的本地封装 `waitPortFree`，`:310`）——保留为公共原语还是收窄服务面？
- **U4**：sentinel/guardian 手抄服务类型而非 import 本包导出类型 → 契约漂移风险（U3 即实例：类型里有、实际无人用）。
- **U5**：仓库无测试目录（无 `tests/*.test.mjs`），验收清单第 1/4/5/6/7/8/9 条缺回归夹具——是否补「bin 空 / 写失败 / 端口占用」三类离线单测？
- **U6**：`.watch-web.log` 与 `.watch-events.log` 有多个写入者（runtime / sentinel / guardian / watch），归属、轮转与截断责任未定义。
- **U7**：`launchCmd` 硬编码 `--expose-internals`（`src/index.ts:134`）——该 flag 是否仍为 web 启动必需，未取证。
