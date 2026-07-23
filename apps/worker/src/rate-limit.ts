/**
 * Limitador de tentativas de login.
 *
 * Sem isso, a tela de login aceita tentativas infinitas: um robô testa milhares
 * de senhas por minuto. Virou crítico quando o painel passou a guardar senhas de
 * produção no cofre (/admin/credenciais) — quem quebra o login leva o chaveiro
 * inteiro — e mais ainda com o admin exposto na internet.
 *
 * Em memória de propósito: o worker é um processo só, e uma dependência externa
 * (Redis) para isso seria trocar um problema simples por um container a mais. Se
 * um dia houver múltiplos workers, migrar para Redis é trocar este arquivo.
 */

type Registro = { falhas: number; primeiraEm: number; bloqueadoAte: number }

const MAX_FALHAS = Number(process.env.LOGIN_MAX_FALHAS) || 5
const JANELA_MS = (Number(process.env.LOGIN_JANELA_SEG) || 900) * 1000 // 15 min
const BLOQUEIO_MS = (Number(process.env.LOGIN_BLOQUEIO_SEG) || 900) * 1000 // 15 min
const LIMITE_ENTRADAS = 10_000 // teto de memória contra flood de IPs forjados

const registros = new Map<string, Registro>()

function limpar(agora: number) {
  for (const [chave, r] of registros) {
    const expirou = agora > r.bloqueadoAte && agora - r.primeiraEm > JANELA_MS
    if (expirou) registros.delete(chave)
  }
}

/**
 * @returns segundos restantes de bloqueio, ou 0 se pode tentar.
 */
export function bloqueioRestante(chave: string): number {
  const r = registros.get(chave)
  if (!r) return 0
  const restante = r.bloqueadoAte - Date.now()
  return restante > 0 ? Math.ceil(restante / 1000) : 0
}

export function registrarFalha(chave: string) {
  const agora = Date.now()
  if (registros.size > LIMITE_ENTRADAS) limpar(agora)

  const r = registros.get(chave)
  // Passou a janela sem estourar o limite: recomeça a contagem.
  if (!r || agora - r.primeiraEm > JANELA_MS) {
    registros.set(chave, { falhas: 1, primeiraEm: agora, bloqueadoAte: 0 })
    return
  }
  r.falhas++
  if (r.falhas >= MAX_FALHAS) {
    r.bloqueadoAte = agora + BLOQUEIO_MS
    r.falhas = 0
    r.primeiraEm = agora
  }
}

/** Login bem-sucedido zera o histórico daquela chave. */
export function limparFalhas(chave: string) {
  registros.delete(chave)
}

/**
 * Chaves de contagem. Contamos por IP **e** por e-mail: só por IP, um atacante
 * distribuído passa batido; só por e-mail, qualquer um tranca a conta do admin
 * de fora (negação de serviço).
 */
export function chaves(ip: string, email: string): string[] {
  return [`ip:${ip}`, `email:${String(email).toLowerCase()}`]
}

/**
 * IP real do cliente, atrás de proxy.
 *
 * NÃO usa o primeiro item de X-Forwarded-For: esse cabeçalho é escrito pelo
 * cliente e só ganha itens confiáveis conforme passa por proxies. Um atacante
 * que mande `X-Forwarded-For: 1.2.3.4` ganharia um contador novo a cada
 * tentativa e o bloqueio não valeria nada.
 *
 * Ordem de confiança:
 *   1. CF-Connecting-IP — a Cloudflare define e SOBRESCREVE o que o cliente mandar;
 *   2. X-Real-IP — definido pelo nosso nginx a partir da conexão real;
 *   3. o IP da conexão.
 *
 * Se um dia o painel ficar exposto sem nginx na frente, isto continua correto:
 * sem os cabeçalhos, cai no IP da conexão.
 */
export function ipDoCliente(req: {
  headers: Record<string, any>
  ip: string
}): string {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  return req.ip
}

/** Exposto para teste. */
export function _limparTudo() {
  registros.clear()
}

export const CONFIG = { MAX_FALHAS, JANELA_MS, BLOQUEIO_MS }
