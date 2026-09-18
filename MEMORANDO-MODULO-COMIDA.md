# Memorando: Módulo Comida do GTRZ System

## Finalidade

Comida é um domínio próprio dentro do GTRZ. Não é apenas um tipo de produto nem uma tela de cadastro paralela. Produtos continuam sendo cadastrados e movimentados pelo Estoque, mas, ao serem vinculados à categoria de domínio `Comida`, devem obedecer às regras financeiras, de estoque, cozinha, fornecedor e combos definidas abaixo.

## Ponto de entrada

1. Todo item, inclusive comida, bebida e ingrediente, é criado no módulo **Estoque**.
2. Não deve existir cadastro de produto duplicado no módulo Comida.
3. A categoria técnica `Comida` deve acionar o motor de comida. Não basta preencher `kind = food` nem trocar um texto na interface.
4. O formulário do Estoque deve mudar conforme o motor da categoria e conforme o modelo de fornecimento configurado para o evento.
5. Categorias devem ser administradas em **Configurações**, com edição e exclusão. Uma categoria que contém produtos não pode ser apagada silenciosamente; o sistema deve exigir a movimentação/exclusão dos produtos ou oferecer uma transferência explícita e auditável.

## Venda em combos

1. Todo produto possui somente uma chave: **Somente em combos**.
2. Essa chave deve ser visualmente uma switch pequena e discreta.
3. Quando ligada, o produto não aparece como venda avulsa no caixa, mas pode ser usado por combos.
4. Não devem existir categorias artificiais como “vendável direto”, “vendável componente” ou tipos paralelos de componente.
5. A mesma regra vale para alimentos, bebidas, gelo, água com gás, whisky e quaisquer outros itens.

## Configuração financeira por evento

Antes de cadastrar ou operar comida para um evento, a Produção define um dos modelos abaixo. Essa escolha precisa aparecer no módulo Comida e controlar o comportamento do cadastro no Estoque.

### Modelo A: GTRZ é a fornecedora

1. A GTRZ compra, possui e vende a comida.
2. O cadastro no Estoque usa custo, entrada por lote, estoque, preço de venda e margem da mesma forma que os demais produtos próprios.
3. A entrada de alimentos é custo/estoque da GTRZ e entra nas despesas, faturamento, custo do estoque e lucro.
4. Ingredientes vendidos apenas por combos também possuem custo e quantidade próprios.
5. O resultado de um combo deve considerar o custo de todos os seus componentes, inclusive comida, whisky, águas e demais itens.
6. O módulo Comida apresenta uma visão própria de quantidade vendida, receita, custo e lucro dos itens alimentares, sem perder a consolidação na Visão geral, Despesas e Estoque.

### Modelo B: fornecedor externo

1. O parceiro fornece a comida, assume o custo e absorve o prejuízo do que não vender.
2. A GTRZ registra todas as vendas em seu próprio caixa; a cozinha recebe a nota do pedido e prepara/entrega o produto.
3. O cadastro de uma comida externa ocorre no **Estoque**, mas usa o motor de comida externa: fornecedor, valor unitário que pertence ao fornecedor, comissão unitária da GTRZ, quantidade de entrada e opção “Somente em combos”.
4. O preço de venda é calculado automaticamente: `valor do fornecedor + comissão GTRZ`.
5. O “valor do fornecedor” não é custo nem despesa da GTRZ. É valor de repasse.
6. Itens externos continuam tendo quantidade em estoque para controlar disponibilidade e consumo, mas seu estoque não gera custo próprio para a GTRZ.
7. Uma venda paga deve registrar atomicamente: valor recebido no caixa, quantidade baixada, valor a repassar ao fornecedor e comissão da GTRZ.
8. Cancelamento/estorno deve devolver estoque e desfazer o repasse/comissão daquela venda.
9. O módulo Comida deve mostrar, por item: quantidade vendida, total recebido, total do fornecedor e total GTRZ; o cabeçalho mostra os mesmos totais consolidados.

## Fornecedores externos

1. Fornecedor é uma entidade administrativa do evento, visível no módulo Comida.
2. Deve ser possível editar nome e dados operacionais sem reescrever vendas passadas.
3. Se já existirem vendas, o comportamento seguro é arquivar/desativar o fornecedor, preservando pedidos, caixa, estoque, repasses e auditoria; ele deixa de aparecer para novos vínculos.
4. Exclusão definitiva só é permitida sem itens, termos ou vendas vinculados.
5. Apagar fornecedor junto com vendas não deve ser uma ação simples: vendas atingem caixa, pedidos, inventário e auditoria. Caso exista uma função excepcional de expurgo, ela deve ser administrativa, explícita, transacional e detalhar tudo que será removido antes de confirmar.

## Combos e ingredientes compartilhados

1. O sistema precisa suportar produtos que só existem para compor combos e não são vendidos individualmente.
2. Exemplo conceitual: ingredientes compartilhados por dois pratos. Se acabarem os itens necessários, nenhum dos pratos que depende deles pode ser vendido.
3. A quantidade do ingrediente é compartilhada no estoque entre todos os combos que o usam.
4. A venda do combo baixa os componentes reais; não baixa um estoque fictício isolado do combo.
5. Para produto próprio, o custo dos componentes entra no custo/lucro do combo.
6. Para comida externa, o sistema não exige que a GTRZ informe custo interno de cada ingrediente do parceiro. O que importa é o valor contratual do prato/combo, o repasse e a comissão.
7. Para bebida ou produto próprio usado somente em combo, o custo continua obrigatório e deve compor o resultado do combo.

## Variações de pratos e escolhas

1. Combos/pratos não podem ser limitados a receitas fixas simples.
2. O motor precisa suportar escolhas do cliente, alternativas e quantidades: por exemplo, escolher sabores, repetir uma escolha ou misturar opções dentro da quantidade permitida.
3. A escolha deve produzir uma composição concreta antes de fechar a venda, para que o estoque dos componentes corretos seja baixado.
4. A cozinha deve receber na nota a composição/escolhas do pedido, não apenas o nome genérico do combo.
5. A disponibilidade do combo deve considerar todos os componentes obrigatórios e as alternativas válidas disponíveis.

## Caixa, impressão e operação de cozinha

1. Todas as vendas de comida passam pelo caixa GTRZ.
2. Ao registrar uma venda de comida, o sistema imprime uma nota para a cozinha/parceiro.
3. A nota deve conter produto(s), quantidade, escolhas/variações e a informação operacional de quanto cabe ao fornecedor quando aplicável.
4. O fluxo precisa ser rápido; dados repetitivos ou contábeis não devem transformar uma entrada de estoque comum em formulário excessivo.

## Integração contábil e operacional

1. GTRZ fornecedora: receita de venda, custo de estoque e lucro entram no faturamento e nas visões financeiras normais.
2. Fornecedor externo: o total da venda entra no caixa, mas o módulo separa automaticamente o passivo de repasse do parceiro da comissão/receita GTRZ.
3. Estoque, caixa, pedidos, nota de cozinha, repasse e auditoria devem nascer da mesma operação atômica.
4. Dados devem sincronizar entre os computadores pelo mecanismo de eventos já adotado, sem exigir ação manual de atualização.
5. A auditoria precisa registrar autor/dispositivo, horário, produto, quantidade, modelo de fornecimento, fornecedor, valores e eventual cancelamento.

## Critérios de aceite

1. Selecionar `Comida` no Estoque não pode mostrar o formulário genérico de bebida como se nada tivesse mudado.
2. Em evento GTRZ fornecedora, o cadastro de comida exibe e usa custo/lote normal.
3. Em evento com fornecedor externo, o cadastro de comida exibe fornecedor, repasse unitário, comissão unitária e preço final calculado; não chama o repasse de custo.
4. Item marcado “Somente em combos” não aparece em venda avulsa, mas reduz corretamente o estoque de combos.
5. Venda e cancelamento atualizam caixa, estoque, comissão, repasse, auditoria e sincronização de maneira consistente.
6. O módulo Comida apresenta números claros, compactos e legíveis; não despeja JSON técnico no operador.

## Falha observada na implementação atual

Na tela registrada em 18/09/2026, a categoria `Comida` apenas levou o formulário a continuar exibindo `Preço de custo`, `Preço de venda` e o fluxo genérico. Isso **não atende** ao requisito de motor de comida. A implementação correta deve ramificar o formulário e o processamento de acordo com o modelo do evento, conforme este memorando.
