# Ambiente de teste

`gtrz-sync-test` e `gtrz-sync` sao centrais diferentes. Cada uma possui Durable Objects,
arquivo R2, chave de pareamento, dispositivos e sessoes de caixa independentes.

## Enderecos

- Oficial: `https://gtrz-sync.jvgacontato.workers.dev`
- Teste: `https://gtrz-sync-test.jvgacontato.workers.dev`
- Caixa de teste: `https://gtrz-sync-test.jvgacontato.workers.dev/cashier`
- Monitor de teste: `https://gtrz-sync-test.jvgacontato.workers.dev/monitor`

## Regras de seguranca

- Nunca use a chave oficial no ambiente de teste, nem a chave de teste na central oficial.
- No mesmo GTRZ System, o seletor do modulo Nuvem reinicia no ambiente escolhido e usa outro
  SQLite, outra fila e outro identificador de maquina.
- Nao existe envio automatico do teste para a operacao oficial.
- Copiar configuracoes entre ambientes deve ser uma acao futura, revisada e limitada a catalogo;
  vendas, caixa, despesas, estoque, sessoes e auditoria nao sao transferiveis.

## Publicacao

```powershell
npm run cloud:check:test
npm run cloud:deploy:test
```

O workflow do GitHub valida os dois Workers e, quando o segredo `CLOUDFLARE_API_TOKEN` estiver
configurado, publica primeiro o teste e depois o Worker oficial.
