# certs/

Pasta para o **certificado digital A1** usado pela sonda SEFAZ (mTLS).

O conteúdo desta pasta é ignorado pelo git e pelo build do Docker — só este README e o
`.gitkeep` são versionados. **Nunca commite um `.pfx` nem a senha dele.**

## Como usar

1. Copie o certificado A1 para cá com um nome sem espaços e **sem a senha no nome**:

   ```sh
   cp "/caminho/do/CERTIFICADO.pfx" certs/vetor-a1.pfx
   chmod 600 certs/vetor-a1.pfx
   ```

2. Coloque o caminho e a senha no `.env` da raiz (que também é ignorado pelo git):

   ```sh
   NFE_CERT_PFX_PATH=/certs/vetor-a1.pfx   # caminho DENTRO do container
   NFE_CERT_PASS=a-senha-do-pfx
   ```

3. Suba o worker. A pasta é montada como `/certs` somente-leitura:

   ```sh
   docker compose up --build worker
   ```

Alternativa por alvo: em vez das envs, dá para definir `certPath` e `certPassphrase` no
`config` (JSON) de um `Target` do tipo `sefaz` — útil se UFs diferentes usarem certificados
diferentes.

## Conferir o certificado antes de usar

O OpenSSL do macOS (LibreSSL) não abre `.pfx` legado — use o do Homebrew:

```sh
/opt/homebrew/opt/openssl@3/bin/openssl pkcs12 -in certs/vetor-a1.pfx \
  -nokeys -legacy -passin pass:'A-SENHA' \
  | /opt/homebrew/opt/openssl@3/bin/openssl x509 -noout -subject -issuer -dates
```

O que precisa aparecer:

- **issuer** com uma AC da cadeia **ICP-Brasil** (`AC ... RFB`, `AC Certisign`, `AC Serasa`…).
  Certificado self-signed ou de servidor (Let's Encrypt) **não serve** — a SEFA-PR devolve
  `alert 46 (certificate unknown)` no handshake.
- **notAfter** ainda no futuro. A1 vale 1 ano; vencido, a SEFAZ recusa a conexão.
- `Mac verify error: invalid password?` significa **senha errada**, não arquivo corrompido.

## Contexto

A SEFA-PR (`https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4`) exige A1/mTLS até para o
*status serviço*. Sem certificado, a sonda reporta `degraded` com mensagem explicativa em vez
de `down`, para não abrir incidente falso na página pública — ver
`packages/probes/src/sefaz.ts`.

Só **A1** funciona: o worker lê o `.pfx` como arquivo (`options.pfx` do `node:https`).
Certificado **A3** (token/smartcard) exigiria ponte PKCS#11 e não roda em container.
