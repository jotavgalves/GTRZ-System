# GTRZ Cloud Sync

Servico de sincronizacao em tempo real do GTRZ. Cada evento possui um Durable Object proprio, que serializa comandos, grava um log ordenado e envia as alteracoes confirmadas por WebSocket.

## Fonte de dados de produção

A fonte canônica de dados do desktop e do mobile é o mesmo projeto Supabase:
`muhzjnveqrahccoisddo`, pela Edge Function `gtrz-sync-fallback`.

O Worker serve a interface mobile e encaminha as APIs HTTP de produção `/v1/*`
e `/cashier/api/v1/*` à central canônica. Não há fallback para gravar em uma base
Cloudflare separada quando a central falha. A autenticação e a validação dos
comandos continuam na Edge Function. Os relays internos e WebSockets legados
preservam suas rotas de transporte; o cliente canônico usa o Realtime do Supabase.
O SQLite do desktop permanece como réplica operacional local, com fila de envio
e aplicação auditada do diário remoto.

O Worker de teste mantém os bindings e dados isolados. O alias `/cashier/api`
nesse ambiente é resolvido localmente, sem redirecionamento para produção.
A configuração local ou um PR aberto não altera o Worker publicado: siga o fluxo
de integração e publicação documentado em `EDITING.md`.

## Segredo de acesso

Antes de usar o servico publicado, configure uma chave longa e exclusiva:

```powershell
$key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$key | npx wrangler secret put GTRZ_SYNC_KEY
```

Os clientes enviam a chave no cabecalho `X-GTRZ-Key` e um identificador estavel no cabecalho `X-GTRZ-Device-Id`.

Guarde a chave somente no computador de Producao. Ela e um bootstrap temporario; o pareamento
definitivo deve emitir credenciais independentes e revogaveis por dispositivo.

## Rotas

- `GET /health`
- `POST /v1/events/{eventId}/stock`
- `POST /v1/events/{eventId}/sales`
- `GET /v1/events/{eventId}/snapshot?after={sequence}`
- `GET /v1/events/{eventId}/stream?after={sequence}` via WebSocket

Os comandos exigem `commandId` unico. O reenvio retorna exatamente a mesma resposta, sem duplicar a venda ou a baixa de estoque.

## Garantias do nucleo

- Cada evento e processado por uma unica instancia logica, com sequencia crescente no `event_log`.
- A venda verifica e baixa todos os itens dentro de uma unica transacao SQLite do Durable Object.
- Duas vendas simultaneas pela ultima unidade resultam em uma confirmacao e uma resposta `409 STOCK_INSUFFICIENT`.
- A conexao WebSocket recebe um snapshot inicial e, depois, cada evento confirmado sem polling.
