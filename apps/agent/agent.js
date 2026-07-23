#!/usr/bin/env node
/**
 * Agente do painel-servicos-vetor.
 *
 * Roda DENTRO do servidor monitorado e empurra métricas para o painel. Existe
 * porque as portas internas (bancos) ficam fechadas para a internet — de fora
 * elas são invisíveis — e porque "container reiniciando" e "disco cheio" são as
 * causas mais comuns de queda num host com muitos containers.
 *
 * Deliberadamente SEM dependências npm e em JavaScript puro: precisa rodar em
 * qualquer Node 18+ sem `npm install`, inclusive num container mínimo.
 *
 * Configuração (variáveis de ambiente):
 *   PAINEL_URL     obrigatória  ex.: https://painel.vetor.com.br
 *   AGENT_TOKEN    obrigatória  token gerado em POST /api/hosts
 *   INTERVALO_SEG  opcional     padrão 60
 *   DOCKER_SOCK    opcional     padrão /var/run/docker.sock
 *   PORTAS         opcional     lista "rotulo:porta" separada por vírgula
 *                               ex.: "Postgres:5432,Redis:6379"
 *   MOUNTS         opcional     pontos de montagem, padrão "/"
 */

const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const PAINEL_URL = process.env.PAINEL_URL
const AGENT_TOKEN = process.env.AGENT_TOKEN
const INTERVALO_MS = (Number(process.env.INTERVALO_SEG) || 60) * 1000
const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock'
const MOUNTS = (process.env.MOUNTS || '/').split(',').map((s) => s.trim()).filter(Boolean)
const PORTAS = (process.env.PORTAS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((par) => {
    const [rotulo, porta] = par.split(':')
    return { rotulo: rotulo.trim(), porta: Number(porta) }
  })
  .filter((p) => Number.isFinite(p.porta))

if (!PAINEL_URL || !AGENT_TOKEN) {
  console.error('[agente] defina PAINEL_URL e AGENT_TOKEN. Abortando.')
  process.exit(1)
}

// ---------- CPU ----------
// %CPU precisa de duas amostras: guardamos a anterior entre ciclos.
let cpuAnterior = null

function amostraCpu() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const tipo of Object.keys(c.times)) total += c.times[tipo]
    idle += c.times.idle
  }
  return { idle, total }
}

function cpuPct() {
  const agora = amostraCpu()
  if (!cpuAnterior) {
    cpuAnterior = agora
    return undefined // primeira leitura não tem referência
  }
  const dIdle = agora.idle - cpuAnterior.idle
  const dTotal = agora.total - cpuAnterior.total
  cpuAnterior = agora
  if (dTotal <= 0) return undefined
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100))
}

// ---------- Memória ----------
/**
 * Percentual de memória realmente indisponível.
 *
 * NÃO usa os.freemem(): no Linux ela devolve MemFree, que exclui page cache e
 * buffers — memória que o kernel devolve na hora em que alguém precisar. Um
 * servidor saudável com bastante cache apareceria com ~95% "usado" e viveria em
 * alarme falso. MemAvailable é a estimativa correta do que dá para alocar.
 */
function memUsadaPct() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8')
    const kb = (campo) => Number(new RegExp(`^${campo}:\\s+(\\d+) kB`, 'm').exec(info)?.[1])
    const total = kb('MemTotal')
    const disponivel = kb('MemAvailable')
    if (total > 0 && Number.isFinite(disponivel)) {
      return ((total - disponivel) / total) * 100
    }
  } catch {
    // Sem /proc (macOS/Windows): cai no os.freemem, menos preciso mas melhor que nada.
  }
  const total = os.totalmem()
  return ((total - os.freemem()) / total) * 100
}

// ---------- Disco ----------
function discos() {
  const out = []
  for (const mount of MOUNTS) {
    try {
      const s = fs.statfsSync(mount)
      const total = s.blocks * s.bsize
      // bavail (livre para não-root) é o que importa na prática, mas o "usado"
      // do df considera o reservado do root — usamos a mesma conta do df.
      const livre = s.bavail * s.bsize
      const usado = total - s.bfree * s.bsize
      const denom = usado + livre
      if (denom <= 0) continue
      out.push({
        mount,
        usadoPct: (usado / denom) * 100,
        livreGb: livre / 1024 ** 3,
      })
    } catch (err) {
      console.error(`[agente] disco ${mount}: ${err.message}`)
    }
  }
  return out
}

// ---------- Docker ----------
function dockerContainers() {
  return new Promise((resolve) => {
    if (!fs.existsSync(DOCKER_SOCK)) return resolve([])
    // Engine API pelo socket unix: dispensa o CLI do docker na imagem.
    const req = http.request(
      { socketPath: DOCKER_SOCK, path: '/containers/json?all=1', method: 'GET', timeout: 10000 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`[agente] docker respondeu ${res.statusCode}`)
            return resolve([])
          }
          try {
            const lista = JSON.parse(body).map((c) => {
              const nome = (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '')
              // "Up 3 hours (healthy)" -> healthy
              const health = /\((healthy|unhealthy|starting)\)/.exec(c.Status || '')?.[1] ?? null
              return { nome, estado: c.State, health, status: c.Status }
            })
            resolve(lista)
          } catch (err) {
            console.error('[agente] resposta do docker ilegível:', err.message)
            resolve([])
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => {
      console.error('[agente] docker:', err.message)
      resolve([])
    })
    req.end()
  })
}

/** RestartCount só vem no inspect, não na listagem. */
function reiniciosDo(nome) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: DOCKER_SOCK, path: `/containers/${encodeURIComponent(nome)}/json`, timeout: 10000 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).RestartCount ?? null)
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    req.end()
  })
}

// ---------- Portas internas ----------
function checarPorta(porta, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let feito = false
    const fim = (aberta) => {
      if (feito) return
      feito = true
      s.destroy()
      resolve(aberta)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => fim(true))
    s.once('timeout', () => fim(false))
    s.once('error', () => fim(false))
    s.connect(porta, '127.0.0.1')
  })
}

// ---------- Envio ----------
function enviar(relato) {
  return new Promise((resolve) => {
    const alvo = new URL('/api/ingest/agent', PAINEL_URL)
    const corpo = JSON.stringify(relato)
    const lib = alvo.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        method: 'POST',
        hostname: alvo.hostname,
        port: alvo.port || (alvo.protocol === 'https:' ? 443 : 80),
        path: alvo.pathname,
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(corpo),
          Authorization: `Bearer ${AGENT_TOKEN}`,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout ao enviar')))
    req.on('error', (err) => resolve({ status: 0, body: err.message }))
    req.write(corpo)
    req.end()
  })
}

async function ciclo() {
  const containers = await dockerContainers()
  for (const c of containers) {
    c.reinicios = await reiniciosDo(c.nome)
  }

  const portas = []
  for (const p of PORTAS) {
    portas.push({ ...p, aberta: await checarPorta(p.porta) })
  }

  const relato = {
    cpuPct: cpuPct(),
    memUsadaPct: memUsadaPct(),
    uptimeSeg: os.uptime(),
    load1: os.loadavg()[0],
    discos: discos(),
    containers,
    portas,
  }

  const r = await enviar(relato)
  if (r.status === 200) {
    console.log(`[agente] ok — ${containers.length} container(es), ${relato.discos.length} disco(s), ${portas.length} porta(s)`)
  } else {
    // Sem fila local: o painel guarda histórico, e um relato perdido só cria um
    // buraco de um ciclo. Se o silêncio persistir, o watchdog do painel acusa.
    console.error(`[agente] falha ao enviar (HTTP ${r.status}): ${r.body?.slice(0, 200)}`)
  }
}

console.log(`[agente] iniciando — painel ${PAINEL_URL}, a cada ${INTERVALO_MS / 1000}s`)
ciclo().catch((err) => console.error('[agente] erro no ciclo:', err))
setInterval(() => ciclo().catch((err) => console.error('[agente] erro no ciclo:', err)), INTERVALO_MS)
