# Verificação — String Chat 1.7.0

Ambiente: Windows x64, Electron 45.0.0, três perfis isolados no mesmo computador, interface LAN/Radmin detectada e mídia sintética. Não foram usados microfone, webcam, mensagens ou contatos do perfil instalado.

## Verificações automatizadas

- `npm run check`: sintaxe dos módulos de aplicativo, scripts e testes.
- `npm test`: áudio, atalhos, DSP, estados de voz, expiração de PTT dentro da thread de áudio, validação de preferências, limite de bitrate, restrição de controle por canal e falha de configuração sem confirmação de sucesso.
- `npm run test:network`: amizade, mensagens privadas, autenticação, repetição sem duplicatas, anexos de 8 MB, canais, convites, reconexão e persistência.
- `npm run test:desktop`: RNNoise/WASM real, medidor neural, ganho e entrada, redução de ruído sintético, volume por pessoa, atividade de voz, busca de histórico e não lidas em canais/DMs.
- `npm run test:voice-state`: três participantes verificam mute de mic, mute total, retorno ao estado anterior, indicadores em listas/cartões e pessoa entrando depois.
- `npm run test:advanced`: os 12 cenários abaixo, também executados sobre o pacote extraído do setup.
- `npm run test:appearance`: cinco cenários com início sem captura, amigos/DMs, imagem privada com zoom, temas e contraste de texto, chamada/configurações em janela pequena.
- `npm run test:native-media`: oito cenários sobre o executável empacotado, com captura real do monitor e áudio por processo. Verifica som recebido, associação de streams, prioridade de áudio/limite de vídeo, fila local limitada, recuperação do auxiliar sem reiniciar a tela, exclusão do áudio gerado pelo próprio app, estatísticas e fechamento pelo X durante transmissão.

O setup também foi usado para atualizar uma instalação isolada 1.6.1 para 1.7.0, verificando a versão ativa, remoção da versão anterior reconhecida e preservação de arquivos desconhecidos. O perfil instalado do usuário não foi alterado.

Na execução nativa local, a fila de captura ficou entre 6 e 9 ms; isso não representa o atraso total da chamada. O som de teste externo chegou ao receptor, enquanto ligar um tom dentro do app transmissor não elevou o nível recebido acima do ruído de base. O segundo perfil teve reprodução silenciosa no teste para evitar realimentação artificial entre dois programas no mesmo PC.

## Cenários novos

1. Três instâncias se conectam sem ligar câmera ou mic de início.
2. Worker, WASM e modelo MediaPipe reais processam quadros de câmera sintética; desligar encerra trilhas originais e processadas.
3. Uma tecla F23 de teste efetivamente pressionada/solta pelo Windows abre/fecha PTT com a janela minimizada.
4. Interromper o monitor fecha a transmissão e exige soltar/pressionar novamente ao retomar.
5. Telemetria de fala injetada gera aviso com mic mutado sem habilitar a trilha enviada.
6. Dois espectadores recebem codificações independentes: 720p/6 Mbps e 480p/2,5 Mbps a partir de 1080p; somente áudio desliga o vídeo daquele espectador e mantém sua trilha de som.
7. Há sinal de áudio medido após o mixer real. Atenuação preserva o volume do player; posição espacial e mute total atingem os nós de saída.
8. Correção positiva atua no áudio; negativa produz quadros na fila de apresentação. Voltar a zero libera a fila. Buffer de estabilidade é aplicado ao receptor.
9. Selecionar saída altera o destino do contexto; um identificador de saída indisponível é substituído pelo padrão no cenário de teste.
10. Recuperação mantém IDs das trilhas de tela/áudio e a segunda tentativa resulta em VP8 negociado.
11. Player mantém proporção em tela cheia, Esc sai e configurações ficam acessíveis em janela de 950 × 700.
12. Sair do grupo desconecta os nós de reprodução e libera buffers de imagem pendentes.

O log informativo conhecido de inicialização XNNPACK é separado de erros do renderer. Resultados detalhados ficam em `.test-results/`, fora do Git. O pacote inclui os arquivos MediaPipe locais e o auxiliar nativo de PTT; seu manifesto e os hashes dos artefatos são conferidos na preparação da release.

## Limites

Não houve ensaio entre dois PCs físicos, teste prolongado de uma hora, medição de latência ponta a ponta de áudio real ou cobertura de todos os drivers e dispositivos físicos. A desconexão física de um fone e a qualidade visual em diferentes pessoas/iluminações ainda precisam de uso real. Os cenários validam funcionamento, não garantem 1080p60 constante, ausência universal de eco ou um atraso exato de rede.

O atraso de imagem é opcional, limitado a 96 MiB por player e até 20 quadros pendentes; ao atingir o limite, deixa de enfileirar novos quadros temporariamente, preservando os que aguardam apresentação. O desfoque é opcional e pode consumir CPU. Voz/áudio recebidos não são incluídos na captura de som de aplicativos pelo auxiliar Windows existente.
