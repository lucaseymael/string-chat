# Desenvolvimento e versões

Use Windows x64, Node.js 22.12+ e `npm ci`. O Electron é baixado da distribuição oficial durante a instalação das dependências. O compilador C# usado fica em `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

`npm run check` valida a sintaxe. `npm test` verifica áudio, DSP, políticas de reprodução e atalhos. `npm run test:network` exercita mensagens privadas e grupos entre serviços temporários no próprio PC, usando uma interface LAN/Radmin disponível; não usa contatos reais. `npm run test:collaboration` cobre autenticação, mensagens, permissões e chamadas. `npm run test:hosted` cobre HTTPS e persistência, exigindo keytool no PATH ou `STRINGCHAT_TEST_KEYTOOL`.

`npm run build:windows` cria o pacote em `dist/` sem alterar a instalação em uso. Teste captura de tela, webcam e áudio em duas máquinas antes de distribuir uma versão: testes locais não comprovam a qualidade em redes diferentes.

## Próximas versões

1. Atualize `version` em `package.json`, `Version` em `native/InstallSupport.cs` e `AssemblyVersion` em `native/Installer.cs` e `native/Maintenance.cs`.
2. Execute `npm install --package-lock-only --ignore-scripts` para atualizar a versão no lockfile.
3. Atualize as notas e rode as verificações e os testes adequados à mudança.
4. Compile com `npm run build:windows`. Confira setup, ZIP e hashes em `dist/`.
5. Teste atualização e reparo em uma instalação de teste, preservação do perfil e fechamento do app/bandeja.
6. Faça commit, envie a branch e publique uma release com a tag correspondente. Os binários são anexos da release, não commits Git.

Exemplo com GitHub CLI autenticado, depois de enviar o commit:

```powershell
gh release create v1.8.0 dist/StringChat-Setup-1.8.0.exe dist/StringChat-Desktop.zip dist/StringChat-SHA256.txt --title 'String Chat 1.8.0' --notes-file docs/NOTAS-1.8.0.md --target main
```

O workflow **Windows package** pode ser iniciado manualmente em Actions. Ele gera artefatos e não publica nem instala o app em PCs de usuários. Execuções em repositórios privados podem consumir a franquia da conta conforme o uso.

## Distribuição

Não versione `node_modules`, runtime Electron, instaladores, perfis, conversas, convites, certificados ou segredos. O protocolo atual é `stringchat://`; referências ao nome antigo continuam apenas onde necessárias à migração.

O manifesto SHA-256 é montado após alterar ícone e metadados e antes de comprimir. O setup valida o manifesto e verifica o executável antes de confirmar a atualização. Não modifique o diretório portátil após gerar o manifesto.

Após compilar, execute `node scripts/verify-package.mjs <caminho-do-setup-anterior>` para extrair o setup, verificar todos os hashes e testar atualização, limpeza da versão reconhecida, preservação de arquivos desconhecidos e reparo. O destino é novo e isolado em `.build/`; o teste não registra atalhos nem altera a instalação em uso. Sem o argumento, verifica instalação nova e reparo.

O setup instala por usuário, usa um launcher estável e registra a desinstalação no Windows. Versões reconhecidas só são limpas após concluir a nova instalação. Cópias portáteis e pastas desconhecidas não são apagadas. Perfis ficam separados em `%APPDATA%\StringChat`.
