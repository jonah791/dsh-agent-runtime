/**
 * dsh-agent-runtime：守护运行时服务（2026-09-02 主人批准的三插件重构 D2）
 *
 * 提供两个共享服务，消除 sentinel/guardian/preflight 的重复实现与配置漂移：
 *
 * ctx.runtime —— 运行时环境发现（单一来源）：
 *   - bin：dsh bin.js 路径。源码安装特点：从 process.argv[1] 推导（跟随当前进程），
 *     不再硬编码（源码更新/重建后自然跟随）；config.bin 可覆盖。
 *   - profile / port / dshHome / workspace：守护目标环境（config 或环境推导）
 *
 * ctx.webman —— web 进程管理（统一拉起/杀停/端口探测）：
 *   - spawnWeb / killWeb / portOwnerPid / isDshWebProcess / portInUse / waitPortFree
 *   - sentinel（哨兵重启）与 guardian（保活）都注入 ctx.webman，不再各自实现
 *
 * 部署：watch profile 内 insert，先于 sentinel/guardian（它们 inject ['runtime','webman']）。
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'

export const name = 'agent-runtime'
export const inject = [] as const

export interface Config {
  /** 覆盖 bin.js 路径（源码安装通常可从 process.argv[1] 推导，留空自动发现） */
  bin: string
  /** 守护目标 profile */
  profile: string
  /** web 端口 */
  port: number
  /** web API 基址 */
  baseUrl: string
  /** DSH_HOME */
  dshHome: string
  /** 默认 workspace */
  defaultWorkspace: string
  /** 拉起 web 的命令（留空用 [process.execPath, bin, --profile, profile, --no-open]） */
  launchCmd: string[]
}
export const Config = z.object({
  bin: z.string().default(''),
  profile: z.string().default('web'),
  port: z.number().default(3080),
  baseUrl: z.string().default('http://127.0.0.1:3080'),
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  defaultWorkspace: z.string().default(''),
  launchCmd: z.array(z.string()).default([]),
})

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------- ctx.runtime 服务 ----------

export interface RuntimeService {
  /** dsh bin.js 绝对路径（源码安装自动发现 + config 覆盖） */
  readonly bin: string
  /** 守护目标 profile */
  readonly profile: string
  /** web 端口 */
  readonly port: number
  /** web API 基址 */
  readonly baseUrl: string
  /** DSH_HOME */
  readonly dshHome: string
  /** 默认 workspace */
  readonly workspace: string
  /** web 启动命令数组 */
  readonly launchCmd: string[]
  /** 重解析环境（bin 文件变化后调用） */
  resolve(): void
}

export interface WebmanService {
  /** 拉起 web。返回子进程（可 kill/跟踪）；onExit 在子进程退出时回调 */
  spawnWeb(workspace: string, onExit?: (code: number | null, signal: string | null) => void): Promise<ChildProcess | null>
  killWeb(pid: number): Promise<boolean>
  portOwnerPid(): Promise<number | null>
  isDshWebProcess(pid: number): Promise<boolean>
  portInUse(port?: number): Promise<boolean>
  waitPortFree(maxWaitMs?: number): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentRuntime: RuntimeService
    webman: WebmanService
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('agent-runtime')
  const dshHome = config.dshHome || process.env.DSH_HOME || process.cwd()

  // ---------- bin 发现（源码安装：跟随当前进程的 bin.js） ----------
  // 源码安装特点：dsh 从 checkout 的 apps/cli/lib/bin.js 运行。
  // 当前进程若是 dsh（watch/web），process.argv[1] 即 bin.js；否则从 env/常用路径兜底。
  function discoverBin(): string {
    if (config.bin) return config.bin
    const argv1 = process.argv[1]
    if (argv1 && /bin\.js$/.test(argv1) && existsSync(argv1)) return argv1
    // 兜底：DSH_HOME 或已知源码位置
    const candidates = [
      join(dshHome, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
      'E:/alice/deepseek-harness/apps/cli/lib/bin.js',
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return ''
  }

  let bin = discoverBin()
  const profile = config.profile
  const port = config.port
  const baseUrl = config.baseUrl
  const workspace = config.defaultWorkspace || process.cwd()
  const launchCmd = config.launchCmd.length > 0
    ? config.launchCmd
    : (bin ? [process.execPath, '--expose-internals', bin, '--profile', profile, '--no-open'] : [])

  const runtime: RuntimeService = {
    get bin() { return bin },
    get profile() { return profile },
    get port() { return port },
    get baseUrl() { return baseUrl },
    get dshHome() { return dshHome },
    get workspace() { return workspace },
    get launchCmd() { return launchCmd },
    resolve() {
      const b = discoverBin()
      if (b !== bin) {
        logger.info('bin 路径更新: ' + bin + ' -> ' + b)
        bin = b
      }
    },
  }
  ctx.provide('agentRuntime', runtime)

  // ---------- ctx.webman 服务（从 sentinel/guardian 抽取的公共进程管理） ----------

  const portInUse = (p: number = port) =>
    new Promise<boolean>((r) => {
      const s = net.connect({ port: p, host: '127.0.0.1' })
      s.once('connect', () => { s.destroy(); r(true) })
      s.once('error', () => r(false))
    })

  const portOwnerPid = async (): Promise<number | null> => {
    try {
      const out = await new Promise<string>((resolvePromise, reject) => {
        execFile('netstat', ['-ano'], { timeout: 5000 }, (err, stdout) => {
          if (err) reject(err); else resolvePromise(stdout)
        })
      })
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(new RegExp('TCP\\s+127\\.0\\.0\\.1:' + port + '\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)'))
        if (m && m[1]) return Number(m[1])
      }
    } catch { /* 忽略 */ }
    return null
  }

  const isDshWebProcess = async (pid: number): Promise<boolean> => {
    try {
      const out = await new Promise<string>((resolvePromise, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "').CommandLine"], { timeout: 8000 }, (err, stdout) => {
          if (err) reject(err); else resolvePromise(stdout)
        })
      })
      return (/bin\.js/.test(out) && /\bweb\b/.test(out)) || /@deepseek-ai\/dsh/.test(out)
    } catch { return false }
  }

  const killWeb = async (pid: number): Promise<boolean> => {
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolvePromise) => {
          execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 8000 }, () => resolvePromise())
        })
      } else {
        process.kill(pid)
      }
    } catch { /* 继续探测 */ }
    for (let i = 0; i < 12; i += 1) {
      try { process.kill(pid, 0) } catch { return true }
      await sleep(500)
    }
    return false
  }

  const spawnWeb = (ws: string, onExit?: (code: number | null, signal: string | null) => void): Promise<ChildProcess | null> =>
    new Promise((resolvePromise) => {
      void (async () => {
        const cmd = runtime.launchCmd
        if (cmd.length === 0) {
          logger.error('web 启动命令为空（bin 未发现？）——检查 runtime.bin')
          resolvePromise(null)
          return
        }
        logger.info('启动 web: ' + cmd.join(' ') + '（cwd=' + ws + '）...')
        let child: ChildProcess
        try {
          const env = { ...process.env, NODE_USE_ENV_PROXY: '1' }
          child = spawn(cmd[0] ?? 'node', cmd.slice(1), { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], shell: cmd[0] === 'npx', env })
        } catch (err) {
          logger.error('spawn 抛错: ' + String(err))
          resolvePromise(null)
          return
        }
        child.stdout?.on('data', (d: Buffer) => {
          // 捕获 web 打印的带 token 认证 URL（dsh web: http://.../?token=...）→ 写 .web-url 供登录脚本/爱丽丝读取
          try {
            const text = d.toString('utf8')
            const m = /dsh web:\s*(\S+)/.exec(text)
            if (m?.[1]) {
              const url = m[1]
              mkdirSync(dshHome, { recursive: true })
              writeFileSync(join(dshHome, '.web-url'), url, 'utf8')
              logger.info('已捕获 web 认证 URL -> ' + join(dshHome, '.web-url'))
              try { writeFileSync(join(dshHome, '.watch-events.log'), '[' + new Date().toISOString() + '] web 认证 URL 已捕获\n', { flag: 'a' }) } catch { /* 忽略 */ }
            }
          } catch { /* 忽略 */ }
          try { process.stderr.write(d) } catch { /* 忽略 */ }
        })
        child.stderr?.on('data', (d: Buffer) => { try { process.stderr.write(d) } catch { /* 忽略 */ } })
        child.on('error', () => { /* 交给 exit */ })
        child.on('exit', (code, signal) => {
          if (onExit) onExit(code, signal)
        })
        resolvePromise(child)
      })()
    })

  const waitPortFree = async (maxWaitMs = 300000): Promise<boolean> => {
    const deadline = Date.now() + maxWaitMs
    while (await portInUse()) {
      if (Date.now() > deadline) return false
      await sleep(5000)
    }
    return true
  }

  const webman: WebmanService = {
    spawnWeb,
    killWeb,
    portOwnerPid,
    isDshWebProcess,
    portInUse,
    waitPortFree,
  }
  ctx.provide('webman', webman)

  ctx.effect(() => {
    logger.info('dsh-agent-runtime 就绪 v5（HMR 实测轮次3）：bin=' + (bin || '未发现') + ' profile=' + profile + ' port=' + port)
    // HMR 可观测：写事件日志（stdout 可能不可见，事件日志是可靠观测通道）
    try {
      mkdirSync(dshHome, { recursive: true })
      writeFileSync(join(dshHome, '.watch-events.log'), '[' + new Date().toISOString() + '] runtime 就绪 v5（HMR 实测轮次3）\n', { flag: 'a' })
    } catch { /* 忽略 */ }
    return () => { /* 无清理 */ }
  })
}
