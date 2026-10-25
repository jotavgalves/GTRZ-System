# Instalar o GTRZ System em outro PC

Use o Windows PowerShell 5.1 como Administrador, na conta Windows que vai operar o sistema. A
release `v0.1.1-auto-install.1` publica o desktop, o simulador mobile e `install-gtrz.ps1`.

```powershell
$script = Join-Path $env:TEMP 'install-gtrz.ps1'
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/jotavgalves/GTRZ-System/releases/download/v0.1.1-auto-install.1/install-gtrz.ps1' -OutFile $script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
```

O script baixa os instaladores da release e confere seus SHA-256 antes de fechar os programas
antigos. Remove os instaladores registrados, pastas de programa e atalhos GTRZ conhecidos,
instala as novas versões e verifica o SQLite e o acesso autenticado a nuvem. Preserva AppData,
bancos locais, filas, credenciais e backups. Nao apaga o clone Git nem pastas pessoais.

Num PC ja vinculado, a credencial local e reutilizada. Num PC novo, o script pede um codigo
temporario de uso unico. Gere-o no GTRZ System do computador administrador em Nuvem > Vincular
computador > Gerar codigo temporario. O codigo expira em 15 minutos. Nao ha chave mestra nem
credencial de dispositivo no GitHub ou no instalador.

Para inspecionar o que seria removido sem alterar o computador:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -PlanOnly
```

O teste automatico nao registra vendas de teste no evento real. Antes da operacao, confira uma
impressao fisica e a atualizacao entre dois computadores de verdade.
