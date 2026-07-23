# Agente do painel

Roda **dentro do servidor monitorado** (ex.: o VPS `77.37.41.177`) e empurra métricas para o
painel. Não é parte do painel — é instalado no outro lado.

## Por que existe

As portas internas do VPS (Postgres, MySQL, Redis) estão fechadas para a internet — como deve
ser. Consequência: de fora, banco e container são **invisíveis**. E disco cheio e container em
crash loop são as causas mais comuns de queda num host com muitos containers, nenhuma delas
detectável por HTTP.

O agente resolve isso empurrando os dados por HTTPS: **não abre porta nova**, funciona atrás de
firewall/NAT, e o painel nunca guarda credencial de produção — só um token que dá acesso a
gravar métricas.

## O que ele reporta

| Item | Vira | Regra |
|---|---|---|
| Uso de disco por mount | `host_metric` | `degraded` ≥85%, `down` ≥95% |
| CPU e memória | `host_metric` | `degraded` ≥90%, `down` ≥98% |
| Containers Docker | `docker_container` | `down` se não estiver `running`; `degraded` se `unhealthy` ou se reiniciou desde o último relato (crash loop) |
| Portas locais (`PORTAS`) | `host_metric` | `down` se recusar conexão |

Cada item vira um alvo no painel **na primeira vez que é relatado** (auto-provisionamento),
sempre com `publico: false`. Quem decide o que o cliente enxerga é o admin — nunca o agente.

## Instalação

**1. Crie o servidor no painel** e guarde o token (ele só aparece uma vez):

```sh
curl -X POST https://SEU-PAINEL/api/hosts \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' \
  -d '{"nome":"VPS Vetor","ip":"77.37.41.177"}'
```

**2. Copie esta pasta para o servidor** e crie um `.env` ao lado do `docker-compose.yml`:

```sh
PAINEL_URL=https://SEU-PAINEL
AGENT_TOKEN=<o token devolvido no passo 1>
INTERVALO_SEG=60
MOUNTS=/hostfs
PORTAS=Postgres:5432,MySQL:3306,Redis:6379
```

**3. Suba:**

```sh
docker compose up -d
docker compose logs -f     # deve aparecer "[agente] ok — N container(es)…"
```

Perdeu o token? `POST /api/hosts/:id/rotacionar-token` gera outro e invalida o anterior.

## Requisitos

Node 18+ (a imagem `node:20-alpine` já resolve). **Sem dependências npm** — é um arquivo `.js`
puro, de propósito: não precisa de `npm install` nem de build para implantar.

## Cuidados

⚠️ **O socket do Docker é montado somente-leitura, mas acesso a ele equivale a root no host.**
Trate o container do agente como componente confiável e construa a imagem a partir deste repo.
Se isso for inaceitável no seu ambiente, rode o `agent.js` direto no host via systemd, sem
container — ele não depende de nada além do Node.

⚠️ **O token dá permissão de gravar métricas naquele host.** Guarde-o no cofre do painel
(`/admin/credenciais`), não em arquivo solto.

## Se o agente parar

O painel tem um **watchdog**: alvo push sem relato por mais de 3× o intervalo vira `down` com a
mensagem "sem relato do agente há ~N min", e abre incidente. Sem isso, um agente morto deixaria
tudo verde para sempre — o pior modo de falha possível num painel de status.

## Verificado

Testado com 30 containers reais: auto-provisionamento, `down` em container parado, `degraded` em
disco acima de 85%, watchdog marcando `down` no silêncio e fechando o incidente sozinho quando o
agente voltou.

Uma armadilha que este agente evita: `os.freemem()` do Node devolve `MemFree` no Linux, que
exclui page cache — um servidor saudável apareceria com ~95% de memória "usada" e viveria em
alarme falso. O agente lê `MemAvailable` de `/proc/meminfo`.
