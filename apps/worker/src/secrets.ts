import crypto from 'node:crypto'

/**
 * Cifragem dos segredos do cofre de credenciais (AES-256-GCM).
 *
 * A chave vive em SECRETS_KEY (variável de ambiente), NUNCA no banco — senão a
 * cifragem seria teatro: quem obtivesse um dump do Postgres teria tudo.
 *
 * Formato armazenado:  v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 * O GCM é autenticado, então adulterar o registro no banco faz o decifrar falhar
 * em vez de devolver lixo silenciosamente.
 *
 * Gerar a chave:  openssl rand -base64 32
 */

const PREFIXO = 'v1'
const ALGO = 'aes-256-gcm'

export class SecretsIndisponivel extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'SecretsIndisponivel'
  }
}

let cache: Buffer | null = null

/** Lê e valida a chave. Lança se ausente/inválida — o cofre falha fechado. */
function getKey(): Buffer {
  if (cache) return cache
  const raw = process.env.SECRETS_KEY
  if (!raw) {
    throw new SecretsIndisponivel(
      'SECRETS_KEY não definida — o cofre de credenciais está desativado. ' +
        'Gere uma chave com `openssl rand -base64 32` e defina SECRETS_KEY no .env.',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new SecretsIndisponivel(
      `SECRETS_KEY inválida: esperado 32 bytes em base64, veio ${key.length}. ` +
        'Gere de novo com `openssl rand -base64 32`.',
    )
  }
  cache = key
  return key
}

/** true se o cofre pode operar. Usado para responder 503 antes de tentar gravar. */
export function cofreDisponivel(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}

/** Motivo de o cofre estar indisponível, ou null se estiver tudo certo. */
export function motivoIndisponivel(): string | null {
  try {
    getKey()
    return null
  } catch (err: any) {
    return String(err?.message ?? err)
  }
}

export function encrypt(texto: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(12) // 96 bits: tamanho recomendado para GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIXO, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decrypt(armazenado: string): string {
  const key = getKey()
  const partes = armazenado.split(':')
  if (partes.length !== 4 || partes[0] !== PREFIXO) {
    throw new SecretsIndisponivel('formato de segredo desconhecido (registro corrompido?)')
  }
  const [, ivB64, tagB64, ctB64] = partes
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // Falha de autenticação = chave trocada ou registro adulterado.
    throw new SecretsIndisponivel(
      'não foi possível decifrar: a SECRETS_KEY mudou ou o registro foi alterado no banco.',
    )
  }
}

/** Máscara para listagem: nunca devolve o valor, só o formato. */
export function mascara(): string {
  return '••••••••'
}
