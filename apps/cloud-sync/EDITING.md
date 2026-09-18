# Editar o Worker pelo GitHub

O Worker publicado e a fonte deste diretorio sao a mesma aplicacao. Toda mudanca deve ser feita em branch e enviada por Pull Request; a publicacao acontece somente depois do merge na `main`.

## Arquivos do caixa mobile

- `src/cashier-page.ts`: estrutura HTML, manifest e icone. Preserve os IDs usados pelo cliente.
- `src/cashier-styles.ts`: visual responsivo do caixa mobile.
- `src/cashier-client.ts`: interacoes de tela, chamadas HTTP e WebSocket.
- `src/index.ts`: rotas, autenticacao, sessoes, WebSocket e regras da central. Nao altere este arquivo para uma mudanca somente visual.

Para alterar o visual pelo ChatGPT, peça explicitamente para modificar apenas `cashier-styles.ts` e, quando necessario, `cashier-page.ts`. A logica de venda, estoque e conexao permanece em `cashier-client.ts`.

## Regras que nao podem quebrar

- Preserve as rotas `/v1/mobile/*` e `/v1/cashier/*`.
- Preserve os WebSockets `/v1/mobile/stream` e `/v1/mobile/session/stream`.
- Nao guarde chaves, senhas ou tokens no codigo ou no GitHub.
- Antes de abrir o Pull Request, rode `npm run cloud:check`.

## Publicacao automatica

O workflow `.github/workflows/deploy-cloud-sync.yml` valida e publica o Worker quando uma mudanca em `apps/cloud-sync` chega a `main`.

Antes da primeira publicacao automatica, crie estes secrets no repositorio em `Settings > Secrets and variables > Actions`:

- `CLOUDFLARE_ACCOUNT_ID`: identificador da conta que possui o Worker `gtrz-sync`.
- `CLOUDFLARE_API_TOKEN`: token Cloudflare com permissao de editar somente o Worker `gtrz-sync` nessa conta.

Sem esses secrets, o workflow falha de forma segura e nada e publicado.
