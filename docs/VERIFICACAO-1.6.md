# Verificação — String Chat 1.6.0

| Verificação | Resultado |
| --- | --- |
| Worklet e atalhos | 4 verificações passaram |
| Processamento de voz | 7 verificações passaram |
| Novas funções no desktop | 11 verificações passaram |
| Regressão de mídia | 20 verificações passaram |
| Regressão de conversas privadas | 10 verificações passaram |
| Áudio real de tela | 7 verificações passaram |
| Protocolo privado | 9 verificações passaram |
| Serviços de grupo | 10 verificações passaram |
| Setup final | Extração, hashes e executável extraído verificados |

Os testes usaram perfis isolados no mesmo PC, interface Radmin/LAN, microfone simulado, ruído sintético e um tom externo de teste. Nenhuma conversa real foi usada. A validação local não estabelece o desempenho entre PCs ou redes diferentes.

Os 11 testes novos estão em `tests/desktop-voice.cjs` e podem ser executados com `npm run test:desktop`. Os demais testes reproduzíveis de protocolo/áudio estão em `tests/`. As regressões completas de empacotamento foram executadas no ambiente de desenvolvimento.
