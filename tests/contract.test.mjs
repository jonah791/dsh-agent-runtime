/**
 * dsh-agent-runtime · 契约守卫（观测不反噬 + 启动命令现算 + 入口契约）。
 *
 * ① **观测绝不反噬主流程**（§5.22 C4）：`writeWebLog` 是 web 崩溃栈的唯一离线取证面，
 *    它跑在子进程 stdout/stderr 的 data 回调里——一旦它抛出，回调抛错会污染 spawn 的流处理。
 *    故：坏路径必须**不抛**，且日志增长必须有界（≤2MB 截半）。
 * ② **启动命令必须按当前 bin 现算**：修前是 apply 顶层一次性快照——`resolve()` 更新了 `bin`，
 *    但 bin 从「未发现」变为「已发现」时 `launchCmd` 仍是空数组 → `spawnWeb` 报「启动命令为空」→ 保活失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeWebLog } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

test('观测不反噬①：坏路径（父级是普通文件）必须不抛——观测失败不得影响 spawn 流回调', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-probe-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a directory')
  try {
    // dshHome 指向一个「文件」→ join(...)/.watch-web.log 的父级不是目录 → append 必失败
    assert.doesNotThrow(() => writeWebLog(blocker, 'out', Buffer.from('boom')))
    assert.doesNotThrow(() => writeWebLog(join(blocker, 'sub'), 'err', Buffer.from('boom')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('观测不反噬②：正常路径落一行带时间戳与流向；日志有界（>2MB 时截半）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-log-'))
  try {
    writeWebLog(dir, 'out', Buffer.from('hello'))
    const file = join(dir, '.watch-web.log')
    assert.match(readFileSync(file, 'utf8'), /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z out\] hello/)
    // 撑到 2MB 以上再写一次 → 必须先截半（防无限增长）
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 10))
    writeWebLog(dir, 'err', Buffer.from('after-truncate'))
    const size = statSync(file).size
    assert.ok(size < 2 * 1024 * 1024, `截半后必须小于阈值，实际 ${size}`)
    assert.match(readFileSync(file, 'utf8'), /after-truncate/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 检测器：apply 顶层把启动命令快照成常量即违规（应经 launchFor(bin) 现算）。 */
function snapshotsLaunchCmd(source) {
  return /^\s*const launchCmd\s*=/m.test(source)
}

test('启动命令现算：apply 顶层不得出现 `const launchCmd =` 快照，launchCmd getter 必须经 launchFor(bin)', () => {
  assert.equal(snapshotsLaunchCmd(indexSrc), false, '启动命令不得一次性快照（bin 后被发现时命令会永远为空）')
  assert.match(indexSrc, /get launchCmd\(\) \{ return launchFor\(bin\) \}/, 'getter 必须按当前 bin 现算')
  assert.match(indexSrc, /const launchFor = \(b: string\): string\[\] => buildLaunchCmd\(config\.launchCmd, b, process\.execPath, profile\)/, '现算必须复用纯函数 buildLaunchCmd')
})

test('启动命令现算·尸体样本：修前的顶层快照写法必须被检测器抓到', () => {
  const corpse = [
    '  const launchCmd = config.launchCmd.length > 0',
    "    ? config.launchCmd",
    "    : (bin ? [process.execPath, '--expose-internals', bin, '--profile', profile, '--no-open'] : [])",
  ].join('\n')
  assert.equal(snapshotsLaunchCmd(corpse), true, '尸体样本必须被抓出')
})

test('入口契约：导出 name/inject/apply，且 inject 为空（runtime 是被依赖的底座，不消费其它服务）', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'agent-runtime')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], [], 'inject 必须为空数组——它是底座，声明依赖会让 sentinel/guardian 挂载顺序变脆')
})

test('仓库卫生：tests 目录不残留临时夹具（观测用例全在 os.tmpdir）', () => {
  const files = readdirSync(join(root, 'tests'))
  assert.deepEqual(files.filter((f) => f.startsWith('.') || f.endsWith('.tmp')), [])
})
