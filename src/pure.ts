/** dsh-agent-runtime · 纯决策层（无 IO：文件存在性/命令输出由调用方注入）。
 *
 * 本插件是 sentinel/guardian/preflight 的**共享运行时底座**（bin 发现 / 启动命令 / 端口归属 /
 * 「这个 pid 是不是我们的 web」）。这些判定原来直接写在 `apply()` 闭包里做 IO，
 * 无法离线验证——而它们恰好是**判错了会误杀进程或拉起重复 web** 的高危判定。
 * 这里只留决策；`existsSync` / `execFile` / `spawn` 全留在 `index.ts`。
 */
import { join } from 'node:path'

/** bin 发现的注入环境（IO 由调用方提供）。 */
export interface BinEnv {
  /** `process.argv[1]`（源码安装下即 dsh 的 bin.js） */
  argv1?: string | undefined
  dshHome: string
  /** 文件存在性判定（生产传 `existsSync`） */
  exists: (path: string) => boolean
}

/** bin 发现的兜底候选（顺序即优先级）。 */
export function binCandidates(dshHome: string): string[] {
  return [
    join(dshHome || process.cwd(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
    'E:/alice/deepseek-harness/apps/cli/lib/bin.js',
  ]
}

/**
 * bin.js 发现：config 覆盖 > 当前进程 argv[1]（源码安装：跟随进程）> 兜底候选 > 空串。
 * 返回空串 = **未发现**（调用方必须响亮处理，不得当成「有个默认值」）。
 */
export function discoverBin(configBin: string, env: BinEnv): string {
  if (configBin) return configBin
  const argv1 = env.argv1
  if (argv1 && /bin\.js$/.test(argv1) && env.exists(argv1)) return argv1
  for (const c of binCandidates(env.dshHome)) {
    if (env.exists(c)) return c
  }
  return ''
}

/**
 * 拉起 web 的命令数组：
 * - 显式配置的 `launchCmd` 优先（原样使用）
 * - 否则用 `[execPath, --expose-internals, bin, --profile, <profile>, --no-open]`
 * - **bin 未发现 → 空数组**（= 明确的「不能拉起」信号，而不是拼出一条必然失败的命令）
 */
export function buildLaunchCmd(configLaunchCmd: readonly string[], bin: string, execPath: string, profile: string): string[] {
  if (configLaunchCmd.length > 0) return [...configLaunchCmd]
  if (!bin) return []
  return [execPath, '--expose-internals', bin, '--profile', profile, '--no-open']
}

/**
 * 从 `netstat -ano` 输出解析占用 `127.0.0.1:<port>` 且处于 LISTENING 的 pid。
 * 找不到 → null（**「不知道谁占着」必须与「知道」可区分**：单点所有权纪律 §5.19 的取证面）。
 */
export function parsePortOwner(stdout: string, port: number): number | null {
  const re = new RegExp('TCP\\s+127\\.0\\.0\\.1:' + port + '\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)')
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.trim().match(re)
    if (m && m[1]) return Number(m[1])
  }
  return null
}

/**
 * 「这个 pid 的进程是不是我们的 dsh web」判定（守护据此决定杀/不杀）。
 * 现状语义（**故意逐字保留，未收紧**）：`(含 bin.js 且含独立单词 web)` 或 `含 @deepseek-ai/dsh`。
 * 注意副作用：`bin\.js` 是**子串**匹配（`mybin.js` 也算），且 `web` 只要求词边界——
 * 收紧词边界会让真 web 判不出（→ 守护以为端口空闲 → 拉起重复 web，比误杀更常见），
 * 故本函数语义变更需与 sentinel/guardian 一起定调（见 docs/semantic.md §10）。
 */
export function isDshWebCommandLine(out: string): boolean {
  const s = String(out)
  return (/bin\.js/.test(s) && /\bweb\b/.test(s)) || /@deepseek-ai\/dsh/.test(s)
}
