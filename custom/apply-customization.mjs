import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] || '')

if (!target || !existsSync(join(target, 'package.json'))) {
  console.error('Usage: node apply-customization.mjs <jarvis-source-directory>')
  process.exit(1)
}

const context = readFileSync(join(here, 'PROJECT-CONTEXT.md'), 'utf8').trim()

function escapeTemplateLiteral(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
}

function findClosingBacktick(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) slashes += 1
    if (slashes % 2 === 0) return i
  }
  return -1
}

function appendContextToPrompt(relativePath, exportPrefix) {
  const path = join(target, relativePath)
  let text = readFileSync(path, 'utf8')
  const start = text.indexOf(exportPrefix)
  if (start < 0) throw new Error(`SYSTEM_PROMPT start not found in ${relativePath}`)
  const bodyStart = start + exportPrefix.length
  const end = findClosingBacktick(text, bodyStart)
  if (end < 0) throw new Error(`SYSTEM_PROMPT end not found in ${relativePath}`)

  const injected = `\n\nPROJECT OVERRIDE — RUSCORP / KODA. The instructions below override earlier persona/style instructions where they conflict.\n\n${escapeTemplateLiteral(context)}\n`
  text = text.slice(0, end) + injected + text.slice(end)
  writeFileSync(path, text)
}

appendContextToPrompt('bridge/server.mjs', 'const SYSTEM_PROMPT = `')
appendContextToPrompt('src/config.ts', 'export const SYSTEM_PROMPT = `')

copyFileSync(join(here, 'openai-koda.mjs'), join(target, 'bridge/openai-koda.mjs'))

{
  const path = join(target, 'scripts/start.mjs')
  let text = readFileSync(path, 'utf8')
  const oldLine = "run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)"
  const replacement = `const engine = process.argv.includes('--openai')\n  ? 'openai'\n  : process.argv.includes('--claude')\n    ? 'claude'\n    : (process.env.JARVIS_ENGINE ?? 'claude').toLowerCase()\nconst bridgeEntry = engine === 'openai' ? 'bridge/openai-koda.mjs' : 'bridge/server.mjs'\nconsole.log(\`  brain engine: \${engine === 'openai' ? 'OpenAI' : 'Claude'}\\n\`)\nrun('bridge', 'node', [bridgeEntry], '36', bridgeEnv)`
  if (!text.includes(oldLine)) throw new Error('Bridge launch line not found in scripts/start.mjs')
  text = text.replace(oldLine, replacement)
  writeFileSync(path, text)
}

{
  const path = join(target, 'src/lib/tts.ts')
  let text = readFileSync(path, 'utf8')
  const oldBlock = `      const u = new SpeechSynthesisUtterance(text)\n      const voice = pickVoice()\n      if (voice) u.voice = voice\n      u.lang = voice?.lang ?? 'en-GB'`
  const newBlock = `      const u = new SpeechSynthesisUtterance(text)\n      const isRussian = /[А-Яа-яЁё]/.test(text)\n      const russianVoice = isRussian\n        ? speechSynthesis.getVoices().find((v) => /^ru/i.test(v.lang)) ?? null\n        : null\n      const voice = isRussian ? russianVoice : pickVoice()\n      if (voice) u.voice = voice\n      u.lang = isRussian ? (russianVoice?.lang ?? 'ru-RU') : (voice?.lang ?? 'en-GB')`
  if (!text.includes(oldBlock)) throw new Error('Native TTS voice block not found in src/lib/tts.ts')
  text = text.replace(oldBlock, newBlock)
  writeFileSync(path, text)
}

{
  const path = join(target, 'index.html')
  let text = readFileSync(path, 'utf8')
  text = text.replace('<html lang="en">', '<html lang="ru">')
  text = text.replace('<title>J.A.R.V.I.S.</title>', '<title>J.A.R.V.I.S. // KODA</title>')
  writeFileSync(path, text)
}

{
  const path = join(target, 'src/ui/Boot.tsx')
  let text = readFileSync(path, 'utf8')
  const replacement = `const LOG = [\n  'RUSCORP PROJECT PROFILE ........ OK',\n  'OHRANA.TECH CONTEXT ............ LOADED',\n  'UPGRADE TOOLCHAIN .............. READY',\n  'GPT / CLAUDE ENGINE ............ READY',\n  'GITHUB SAFETY GATE ............. ARMED',\n  'VOICE INTERFACE ................ ONLINE',\n]`
  const next = text.replace(/const LOG = \[[\s\S]*?\n\]/, replacement)
  if (next === text) throw new Error('Boot LOG block not found')
  writeFileSync(path, next)
}

{
  const path = join(target, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.name = 'jarvis-koda'
  pkg.description = 'Dual-engine JARVIS customised for ohrana.tech, Upgrade and the Ruskorporatsiya workflow.'
  pkg.scripts['start:openai'] = 'node scripts/start.mjs --openai'
  pkg.scripts['start:claude'] = 'node scripts/start.mjs --claude'
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}

copyFileSync(join(here, 'PROJECT-CONTEXT.md'), join(target, 'KODA-PROJECT-CONTEXT.md'))

const notice = `# JARVIS // KODA\n\nThis build is derived from adewaskar/jarvis under the MIT License.\nUpstream project: https://github.com/adewaskar/jarvis\n\nCustom layer: kruglovada1000-sketch/J.A.R.V.I.S.-upgrade\nPrimary projects: ohrana.tech and Upgrade.\nEngines: OpenAI Responses API or Claude Code.\n`
writeFileSync(join(target, 'KODA-NOTICE.md'), notice)

console.log('JARVIS // KODA dual-engine customization applied successfully.')
