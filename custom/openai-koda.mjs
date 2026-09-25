import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const MODEL = process.env.JARVIS_OPENAI_MODEL ?? 'gpt-5.6-sol'
const EFFORT = process.env.JARVIS_OPENAI_EFFORT ?? 'medium'
const API_KEY = process.env.OPENAI_API_KEY ?? ''
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && isDevPort(Number(url.port))
  } catch {
    return false
  }
}

function readContext() {
  try {
    return readFileSync(join(process.cwd(), 'KODA-PROJECT-CONTEXT.md'), 'utf8').trim()
  } catch {
    return 'Ты JARVIS // KODA. Отвечай по-русски кратко, если пользователь не перешёл на другой язык.'
  }
}

const SYSTEM_PROMPT = `${readContext()}\n\nOPENAI MODE:\n- Ты работаешь через OpenAI Responses API.\n- Для голосового ответа обычно достаточно одного-трёх предложений.\n- Не зачитывай URL, JSON и длинные списки вслух.\n- Если инструментов в этом режиме пока нет, не выдумывай их использование.\n- Никогда не утверждай, что изменил GitHub, сайт или устройство, если это действие фактически не выполнялось.\n- Если пользователь спрашивает, какой мозг активен, отвечай: OpenAI, модель ${MODEL}.`

function extractText(response) {
  if (!response || !Array.isArray(response.output)) return ''
  const parts = []
  for (const item of response.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

function send(ws, frame) {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame))
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    return res.end(JSON.stringify({ ok: true, tts: false, stt: false, engine: 'openai', model: MODEL }))
  }
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  let previousResponseId = null
  let active = null

  send(ws, { type: 'ready', servers: [{ name: `openai:${MODEL}` }] })

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'interrupt') {
      active?.abort()
      active = null
      return
    }
    if (msg.type !== 'ask' || typeof msg.text !== 'string') return

    const ask = msg.id ?? ''
    if (!API_KEY) {
      send(ws, {
        type: 'error',
        ask,
        message: 'OPENAI_API_KEY не задан. Добавь ключ OpenAI API и перезапусти JARVIS.',
      })
      return
    }

    active?.abort()
    const controller = new AbortController()
    active = controller

    try {
      const payload = {
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: msg.text,
        reasoning: { effort: EFFORT },
        max_output_tokens: 900,
      }
      if (previousResponseId) payload.previous_response_id = previousResponseId

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = body?.error?.message ?? `OpenAI API returned HTTP ${res.status}`
        throw new Error(detail)
      }

      previousResponseId = body.id ?? previousResponseId
      const text = extractText(body)
      if (!text) throw new Error('OpenAI вернул ответ без текста.')

      for (let i = 0; i < text.length; i += 80) {
        if (controller.signal.aborted) return
        send(ws, { type: 'text', ask, delta: text.slice(i, i + 80) })
      }
      send(ws, { type: 'done', ask, text })
    } catch (err) {
      if (controller.signal.aborted) return
      send(ws, { type: 'error', ask, message: String(err?.message ?? err) })
    } finally {
      if (active === controller) active = null
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-koda] OpenAI bridge listening on http://127.0.0.1:${PORT}`)
  console.log(`[jarvis-koda] engine openai · model ${MODEL} · effort ${EFFORT}`)
})
