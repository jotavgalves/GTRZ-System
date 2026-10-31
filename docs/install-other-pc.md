# Instalar o GTRZ System em outro PC (um comando)

No PC novo, abra o **Prompt de Comando** ou o **PowerShell** (nao precisa ser como Administrador: o
script pede a permissao sozinho) e rode **uma linha**, trocando `SEU-CODIGO` pelo codigo temporario:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://github.com/jotavgalves/GTRZ-System/releases/latest/download/install-gtrz.ps1 -OutFile $env:TEMP\install-gtrz.ps1; & $env:TEMP\install-gtrz.ps1 -Codigo SEU-CODIGO"
```

O codigo sai no GTRZ System do computador administrador, em **Nuvem > Vincular computador > Gerar
codigo temporario**. Ele vale 15 minutos e so serve uma vez. Nao ha chave, senha nem credencial de
dispositivo no GitHub nem no instalador; o codigo e o que permite o PC novo se conectar sozinho.

## O que o comando faz

1. Descobre a **ultima release** publicada, baixa o instalador e confere o SHA-256 contra o que o
   GitHub informa. Se nao bater, para.
2. Fecha o GTRZ System, desinstala o antigo e **apaga as pastas do programa antigo** de todas as
   contas Windows do PC (inclusive o GTRZ System Mobile) e os atalhos.
3. Instala o sistema novo e **vincula o PC a nuvem** com o codigo. Se voce nao passar o codigo, ele
   pergunta na hora.
4. Abre o GTRZ System. Os dados do PC (SQLite, filas, credenciais, backups) ficam preservados.

## Opcoes

- `-Limpo`: antes de instalar, tambem **guarda um backup .zip e apaga os dados locais antigos**
  (`%APPDATA%\@gtrz` de cada conta). O backup fica em `C:\Users\Public\Documents\GTRZ-backup-antigo`.
  Se o backup falhar, nada e apagado. Use em PC que ja teve outro sistema e deve comecar do zero; o PC
  reconstroi os dados a partir da nuvem. **Vendas ainda nao enviadas desse PC nao sobem**: confira que
  nao ha pendencias antes.
- `-ReleaseTag v0.1.1-xxxx`: fixa uma versao em vez da ultima.
- `-IncluirSimuladorMobile`: instala tambem o simulador mobile (por padrao nao instala).
- `-PlanOnly`: so mostra o que seria removido, sem alterar nada.

Exemplo com limpeza total:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://github.com/jotavgalves/GTRZ-System/releases/latest/download/install-gtrz.ps1 -OutFile $env:TEMP\install-gtrz.ps1; & $env:TEMP\install-gtrz.ps1 -Codigo SEU-CODIGO -Limpo"
```

## Impressora termica USB (POS-80)

Nao ha driver de fabricante para instalar. Ao abrir, o GTRZ System cria sozinho a fila de impressao
`POS-80` com o driver "Generic / Text Only", que ja vem no Windows, na porta USB da impressora.
Uma instalacao nova ja vem com a impressora `POS-80` selecionada e a impressao automatica ligada.

- Ligue a impressora e conecte o cabo USB antes de abrir o sistema. Sem ela, nada e criado e a
  impressora pode ser escolhida a mao em Configuracoes.
- Se o Windows recusar a criacao da fila, abra o GTRZ System uma vez como Administrador.
- A nota e desenhada como imagem e enviada em ESC/POS direto a fila, com corte do papel apos cada
  via. Se houver mais de uma porta USB de impressora, a de maior numero e usada; confira em
  Impressoras e scanners.

## Publicar uma versao nova (para quem mantem o repositorio)

O comando acima sempre pega a **ultima release**. Para publicar:

1. Gere o instalador (`npm run package:win`, ou o do CI) e crie uma release no GitHub com **dois
   arquivos**: `GTRZ-System-<versao>-Setup.exe` e `install-gtrz.ps1` (de `scripts/`).
2. A tag deve seguir `v0.1.1-nome.N`. Nao marque como pre-release: `releases/latest` ignora
   pre-releases e rascunhos.

O teste automatico nao registra vendas de teste no evento real. Antes da operacao, confira uma
impressao fisica e a atualizacao entre dois computadores de verdade.
