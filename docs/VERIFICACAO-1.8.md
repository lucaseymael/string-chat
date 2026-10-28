# Verificação — 1.8.0

Testes usam perfis, nomes, certificados e conversas de demonstração, separados do perfil instalado.

## Serviços e autorização

- Pedidos de amizade assinados, chaves por contato, identidades fixadas, replay, presença invisível e bloqueio.
- Respostas, edição, exclusão, reações, mensagens fixadas, concorrência, confirmações perdidas e reenvio idempotente.
- Permissões e hierarquia, canais privados, revogação de leitura, modo lento, timeout, mute/escuta, banimento e expulsão.
- Consentimento de chamada, recusa/cancelamento, sala de duas identidades e rejeição de terceiro com convite vazado.
- HTTPS com certificado explicitamente confiado: rejeição de certificado desconhecido e impressão digital divergente, assinatura de ator/método/caminho/corpo, replay após reinício e limites da fila.
- Entrega offline sem falso estado entregue; arquivos de 8 MiB reconstituídos após reinício; confirmação autenticada do destinatário e alterações pendentes.
- Grupos hospedados ativos sem o criador, histórico/anexos persistidos, eventos filtrados por canal, reinício do serviço e salas privadas efêmeras.

## Aplicativo desktop

`tests/collaboration-desktop.cjs` abre duas instâncias Electron e verifica formatação segura, digitação, respostas, edição, reações, fixação/exclusão, presença e bloqueio, troca de canal, estado global de mute/escuta, reprodução com mute administrativo e chamadas privadas.

`tests/hosted-desktop.cjs` abre duas instâncias e um servidor HTTPS em loopback. Verifica configuração real, diretório, amizade, fechamento/reabertura do destinatário com entrega offline, grupo disponível sem o criador e chamada privada com conexão WebRTC.

Testes específicos de interface cobrem configurações do servidor, lista de grupos, administração e chamadas privadas. As suítes existentes de voz, captura nativa, temas, controles e empacotamento continuam no projeto.

O pacote Windows passou oito verificações de captura nativa: chegada de som real ao espectador, stream compartilhado de áudio/vídeo, política de bitrate/prioridade, fila local curta, recuperação do auxiliar, exclusão de som produzido pelo próprio aplicativo, estatísticas reais e fechamento pelo X durante a transmissão. A fila local observada nessa rodada ficou entre 14,7 e 17,3 ms; isso não mede o atraso total da chamada. O RNNoise/WASM reduziu um estímulo de ruído sintético em aproximadamente 9,4 dB no teste local, sem equivaler a um ensaio em todos os ambientes.

## Limites da verificação

As instâncias e o servidor foram ensaiados no mesmo Windows. Isso não valida desempenho entre países, redes móveis, operadoras com CGNAT, um serviço público sob carga ou disponibilidade permanente. Meta 1080p60, bitrate e latência real dependem de hardware, captura, conteúdo, upload e rede. O serviço hospedado limita voz a seis participantes por canal e não inclui SFU/TURN.

O projeto não oferece ainda fóruns/threads, enquetes, eventos agendados, soundboard, catálogo remoto de GIFs, bots/webhooks, aplicativos móveis ou sobreposição dentro de jogos. Não há promessa de equivalência total com serviços de comunicação de grande escala.

Resultados detalhados são gerados em `.test-results/`, que não entra no repositório público. Certificados e dados de testes não são usados em produção.
