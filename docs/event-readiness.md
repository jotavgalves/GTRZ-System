# Liberação para operação de evento

Não use a presença de "Nuvem conectada" como prova de convergência. O ensaio abaixo deve ser feito no evento de teste isolado, com as mesmas versões e equipamentos que serão usados no evento real. Apague os dados de teste desse ambiente depois da conferência; não gere vendas fictícias no evento oficial.

## Antes de liberar

1. Instale a mesma versão do GTRZ System nos dois PCs e abra o caixa mobile no aparelho que será usado. Confirme evento ativo, perfil, produtos, mesas, vouchers e estoque nos três dispositivos.
2. Em **Nuvem**, confirme fila para enviar = 0, falhas = 0, conflitos = 0 e itens aguardando aplicação = 0 em cada PC. O alerta do topo deve estar ausente. Se houver erro de impressão, resolva-o antes de vender.
3. Em **Backups**, crie um backup manual, verifique a integridade e restaure uma cópia em um ambiente isolado. Confira evento, produtos, estoque, vendas e vouchers na cópia. Guarde outra cópia em mídia fora dos PCs.
4. Faça uma venda de produto simples, uma de combo com escolhas e uma com voucher. Confira cada venda no mobile, nos dois PCs e na nota impressa. Os totais, formas de pagamento, escolhas e movimentos de estoque devem coincidir.
5. Desconecte um PC durante uma venda feita no outro, reconecte-o e confirme que ele recebe a venda uma só vez. Repita com perda de resposta no mobile: use **Resolver venda pendente**; não crie uma nova cobrança.
6. Teste cancelamento e estorno, troque o evento apenas após zerar as filas e confirme que uma venda pendente do evento anterior não pode ser reenviada ao novo.
7. Teste a impressora principal e a alternativa. Confirme que uma venda aceita gera uma única nota e que um erro fica visível no topo do desktop.

## Não liberar se

- Uma venda, pagamento, voucher, estoque ou nota divergir entre os dispositivos.
- Existirem falhas ou conflitos sem explicação, ou uma venda mobile aguardando confirmação.
- Um backup íntegro não puder ser restaurado no ambiente isolado.
- A impressão falhar sem uma alternativa testada.

Durante o evento, não atualize o aplicativo nem troque o evento com operações pendentes. Se a nuvem cair, os PCs podem continuar com fila local; o mobile não grava vendas offline. A equipe deve saber previamente como registrar uma operação manual e quem fará a reconciliação antes de retomá-la no sistema.
