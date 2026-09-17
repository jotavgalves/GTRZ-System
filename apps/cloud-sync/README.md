# GTRZ Cloud Sync

Servico de sincronizacao em tempo real do GTRZ. Cada evento possui um Durable Object proprio, que serializa comandos, grava um log ordenado e envia as alteracoes confirmadas por WebSocket.

## Estado da entrega

O servico esta publicado e o nucleo de estoque/venda esta validado com idempotencia e
concorrencia atomica. Esta primeira versao da API ainda nao esta ligada ao aplicativo Electron:
o proximo passo e incluir o pareamento de dispositivos e encaminhar todas as operacoes do PDV
(pedidos, vouchers, caixa, despesas e ingressos) para esta fonte central antes de confirmar a
alteracao local. Enquanto isso nao for feito, o desktop continua oficialmente offline e local.

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
