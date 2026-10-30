# Acesso proprietário em qualquer PC

O vínculo do computador autoriza a sincronização. O login da conta proprietária autoriza
troca e limpeza global do evento, gerenciamento de computadores e perfis mobile. Os dois
controles são exigidos no PC secundário.

1. Instale a mesma release do GTRZ System em cada PC e vincule cada instalação à nuvem.
2. No módulo **Nuvem**, crie a conta proprietária com o e-mail autorizado no servidor. A
   senha desse login é própria do GTRZ System, não a senha do painel Supabase.
3. Confirme o e-mail se o Supabase solicitar e entre com a mesma conta em cada PC.
4. A sessão do proprietário dura até o app ser fechado. Entre novamente após reiniciar.

O e-mail autorizado fica no segredo `GTRZ_OWNER_EMAIL` da Edge Function. Nunca coloque
senhas, tokens de sessão, chaves de dispositivo ou a chave mestra no GitHub.

Para desenvolver pelo Codex em outro PC, use o mesmo repositório GitHub, atualize a branch,
edite, teste, faça commit e push. Código enviado ao GitHub precisa de uma nova release do
desktop e implantação da Edge Function para entrar em vigor. Dados operacionais ficam no
banco canônico da nuvem e são replicados para o SQLite de cada dispositivo; arquivos
SQLite locais não fazem parte do Git.
