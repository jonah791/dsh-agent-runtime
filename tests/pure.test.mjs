/**
 * dsh-agent-runtime · 纯决策套件（离线；IO 由注入的 exists / 文本样本提供）。
 *
 * 这些判定是**高危判定**：判错会误杀按在跑的 web、或拉起重复 web（单点所有权纪律 §5.19）。
 * 覆盖正常路径 + 失败/退化路径（空串、未发现、畸形 netstat、无关进程、端口不符）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  binCandidates, buildLaunchCmd, discoverBin, isDshWebCommandLine, parsePortOwner,
} from '../lib/pure.js'

const HOME = join('/home', 'dsh')
const existsIn = (...paths) => (p) => paths.includes(p)

test('binCandidates: 顺序固定（DSH_HOME 下的源码位置 → 已知 checkout 位置）', () => {
  const c = binCandidates(HOME)
  assert.equal(c[0], join(HOME, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'))
  assert.equal(c[1], 'E:/alice/deepseek-harness/apps/cli/lib/bin.js')
})

test('binCandidates: 退化输入——dshHome 空串回落 cwd（不产出相对路径）', () => {
  const c = binCandidates('')
  assert.ok(c[0].startsWith(join(process.cwd(), 'deepseek-harness')), c[0])
})

test('discoverBin: config 覆盖优先——即使该路径不存在也照用（显式配置 = 权威）', () => {
  const out = discoverBin('/custom/bin.js', { argv1: '/argv/bin.js', dshHome: HOME, exists: existsIn('/custom/bin.js', '/argv/bin.js') })
  assert.equal(out, '/custom/bin.js')
})

test('discoverBin: 正常路径——跟随当前进程 argv[1]（以 bin.js 结尾且存在）', () => {
  const argv1 = join(HOME, 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
  assert.equal(discoverBin('', { argv1, dshHome: HOME, exists: existsIn(argv1) }), argv1)
})

test('discoverBin: 失败路径——argv[1] 非 bin.js / 不存在 → 走兜底候选', () => {
  const cand = binCandidates(HOME)[0]
  assert.equal(discoverBin('', { argv1: '/usr/bin/node', dshHome: HOME, exists: existsIn(cand) }), cand, '非 bin.js 的 argv1 必须跳过')
  assert.equal(discoverBin('', { argv1: '/miss/bin.js', dshHome: HOME, exists: existsIn(cand) }), cand, 'argv1 不存在必须跳过')
})

test('discoverBin: 退化输入——argv1 缺失 / 候选全不存在 → 空串（未发现必须可辨识）', () => {
  assert.equal(discoverBin('', { argv1: undefined, dshHome: HOME, exists: () => false }), '')
  assert.equal(discoverBin('', { dshHome: HOME, exists: () => false }), '')
})

test('discoverBin: 兜底候选按顺序取第一个存在的', () => {
  const [first, second] = binCandidates(HOME)
  assert.equal(discoverBin('', { dshHome: HOME, exists: existsIn(second) }), second)
  assert.equal(discoverBin('', { dshHome: HOME, exists: existsIn(first, second) }), first, '优先第一个')
})

test('buildLaunchCmd: 显式配置优先，且返回拷贝（调用方改数组不影响已建命令）', () => {
  const configured = ['npx', 'dsh', 'web']
  const out = buildLaunchCmd(configured, '/bin.js', '/node', 'web')
  assert.deepEqual(out, configured)
  assert.notEqual(out, configured)
})

test('buildLaunchCmd: 正常路径——[execPath, --expose-internals, bin, --profile, <profile>, --no-open]', () => {
  assert.deepEqual(buildLaunchCmd([], '/bin.js', '/node', 'web'), ['/node', '--expose-internals', '/bin.js', '--profile', 'web', '--no-open'])
})

test('buildLaunchCmd: 失败路径——bin 未发现 → 空数组（明确「不能拉起」，不拼一条必然失败的命令）', () => {
  assert.deepEqual(buildLaunchCmd([], '', '/node', 'web'), [])
  assert.deepEqual(buildLaunchCmd([], '', '/node', 'web').length, 0)
})

test('parsePortOwner: 正常路径——取 LISTENING 行的 pid', () => {
  const out = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       19000',
    '  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       4321',
  ].join('\r\n')
  assert.equal(parsePortOwner(out, 3080), 19000)
  assert.equal(parsePortOwner(out, 5432), 4321)
})

test('parsePortOwner: 失败/退化路径——空输出 / 无匹配 / 端口不符 / 非 LISTENING / 畸形 pid → null', () => {
  assert.equal(parsePortOwner('', 3080), null)
  assert.equal(parsePortOwner('TCP    127.0.0.1:9999   0.0.0.0:0   LISTENING   5', 3080), null, '端口不符')
  assert.equal(parsePortOwner('  TCP    127.0.0.1:3080   0.0.0.0:0   ESTABLISHED   5', 3080), null, '非 LISTENING 不算占用者')
  assert.equal(parsePortOwner('  TCP    127.0.0.1:30800  0.0.0.0:0   LISTENING   5', 3080), null, '端口号不得前缀匹配（30800 ≠ 3080）')
  assert.equal(parsePortOwner('  TCP    0.0.0.0:3080   0.0.0.0:0   LISTENING   5', 3080), null, '只认 127.0.0.1 绑定（现状语义）')
  assert.equal(parsePortOwner('  TCP    127.0.0.1:3080   0.0.0.0:0   LISTENING   abc', 3080), null, 'pid 非数字')
  assert.equal(parsePortOwner('  TCP    [::1]:3080    [::]:0   LISTENING   5', 3080), null, 'IPv6 行不匹配（现状语义）')
})

test('parsePortOwner: 「不知道」与「知道」可区分——null vs 0 不得混淆', () => {
  assert.equal(parsePortOwner('  TCP    127.0.0.1:3080   0.0.0.0:0   LISTENING   0', 3080), 0, 'pid 0 是合法读数')
  assert.equal(parsePortOwner('nonsense', 3080), null)
})

test('isDshWebCommandLine: 正常路径——bin.js + web profile / @deepseek-ai/dsh 都判为我们的 web', () => {
  assert.equal(isDshWebCommandLine('node E:\\alice\\deepseek-harness\\apps\\cli\\lib\\bin.js --profile web --no-open'), true)
  assert.equal(isDshWebCommandLine('"C:\\Program Files\\nodejs\\node.exe" .../node_modules/@deepseek-ai/dsh-cli/lib/bin.js'), true)
})

test('isDshWebCommandLine: 失败/退化路径——空输出 / 无关进程 / 非 web profile 判否', () => {
  assert.equal(isDshWebCommandLine(''), false)
  assert.equal(isDshWebCommandLine('C:\\Windows\\System32\\svchost.exe -k netsvcs'), false)
  assert.equal(isDshWebCommandLine('node /some/bin.js --profile watch'), false, 'watch profile 不是 web')
})

test('isDshWebCommandLine: 文档化 quirk——`bin\\.js` 是子串匹配（mybin.js 也算），语义未收紧', () => {
  // 收紧词边界会让真 web 判不出（→ 守护以为端口空闲 → 拉起重复 web），故**故意保留**现状。
  // 本用例把现状钉住，风险登记在 docs/semantic.md §10。
  assert.equal(isDshWebCommandLine('node /opt/mybin.js --mode web'), true)
  assert.equal(isDshWebCommandLine('pwsh -c "echo web"'), false, '光有 web 不算（还须 bin.js 或 @deepseek-ai/dsh）')
})
