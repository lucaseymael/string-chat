# String Chat 1.5.0 — erros encontrados e correções

Verificação em Windows, em 27 de outubro de 2026. Este relatório distingue os relatos recebidos das verificações feitas em instâncias locais.

| Caso | O que foi encontrado | Correção e verificação |
| --- | --- | --- |
| X não encerrava durante uma chamada | O renderer impedia a saída quando havia participantes conectados. O Electron podia manter a janela aberta, sem uma confirmação útil. | Removido esse bloqueio. Verificados participante, criador do grupo, configurações abertas, seletor de tela aberto e fechamento enquanto tela e som estavam transmitindo. |
| Alerta ERR_FAILED (-2) mostrado durante o meu teste | O teste consultou a janela antes de o carregamento terminar e encerrou a instância. O cancelamento da página local era mostrado como falha de inicialização. | O teste aguarda a interface quando necessário e o app distingue encerramento voluntário de falha real. Fechamento durante o carregamento repetido três vezes, sem alerta falso. Falhas reais de inicialização continuam sendo informadas. |
| Som com atraso acumulado | A fila local aceitava até aproximadamente 250 ms de áudio; o início esperava cerca de 43 ms. | Início com 20 ms; dados antigos são descartados quando necessário, com limite de 80 ms da fila. No teste real, as amostras ficaram entre 16 e 20 ms. Esse número é da fila local, não do atraso total entre computadores. |
| Oscilação da resolução | O modo de movimento priorizava FPS e permitia reduzir a resolução automaticamente. | Separadas as prioridades de movimento e de resolução. O padrão agora prioriza manter a resolução; o usuário pode escolher manter fluidez. Validado recebimento em 1920 × 1080. Rede e hardware ainda podem limitar a transmissão. |
| Tela sem som depois de falha da captura | Uma interrupção do componente nativo removia o som e não o recuperava automaticamente. Algumas fontes também dependiam do tipo informado pelo navegador para iniciar a captura. | O desktop tenta a captura nativa segura para a fonte escolhida. Recupera automaticamente falhas transitórias, tem botão Recuperar áudio e mostra estado de áudio. O teste encerrou o componente de captura e confirmou que o som voltou sem reiniciar o vídeo. |
| Diferença de áudio e vídeo | As trilhas eram independentes e sem uma associação explícita ao mesmo stream RTP. | Áudio e vídeo da tela compartilham o mesmo identificador; microfone e webcam continuam separados. Validação de SDP e áudio recebido por outro processo. A associação usa [setStreams](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setStreams). |
| Áudio perdendo espaço para vídeo | O vídeo tinha prioridade alta; não havia preferência explícita equivalente para as trilhas de áudio. | Áudio recebe prioridade alta e vídeo prioridade média. Receptor solicita uma fila curta com [jitterBufferTarget](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget), quando suportado. As estatísticas mostram as filas reais, que podem variar. |
| Atualização acumulava versões e não aparecia para desinstalar | O setup anterior extraía outra pasta, sem limpeza das anteriores e sem entrada de desinstalação. | Setup novo valida hashes, verifica o executável, fecha o app instalado, troca a versão e só depois remove versões anteriores reconhecidas. Tem launcher estável, reparo e entrada em Aplicativos instalados. |

## Testes do instalador

Passaram: migração de uma instalação 1.4, remoção da pasta antiga reconhecida, preservação de arquivos desconhecidos e perfil, launcher estável, atualização/reparo com o programa aberto em modo de bandeja, rejeição de pacote corrompido preservando a instalação atual e atualização futura simulada para 1.6.

Os testes usaram pastas isoladas dentro do workspace. Não foram gravados atalhos nem alteradas entradas reais do Registro durante esses testes. A integração com atalhos, protocolos e desinstalação é executada pelo setup quando o usuário instala normalmente.

## X e bandeja: comportamento definido

- Por padrão, o X encerra o programa.
- A opção Continuar na bandeja ao clicar no X mantém o app e a chamada abertos, oculta a janela e informa como sair.
- Sair do String Chat, no menu da bandeja, encerra mesmo com essa opção ligada. Esse caminho também foi testado.
- O setup consegue fechar o app antes de atualizar, inclusive quando ele está na bandeja.

## Diagnóstico de outros computadores

Em Ajuda → Salvar diagnóstico deste PC, é possível salvar versão do Windows e métricas de captura/rede. O arquivo não inclui mensagens, nomes de amigos, convites, senhas ou IPs. Esse arquivo ajuda a investigar os computadores dos amigos sem supor que o resultado local representa a conexão deles.

A captura que exclui a voz da call usa a API de loopback por processo do Windows. A API requer build 20348 ou posterior; o app informa quando ela não está disponível e mantém a proteção contra recapturar a própria chamada. Consulte a [amostra oficial da Microsoft](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

## Limites da validação

Os testes de rede usaram processos no mesmo computador pela interface Radmin. O áudio foi verificado com um tom sintético, a captura do monitor foi real e as webcams foram simuladas. Não foi medido o atraso entre os dois PCs dos seus amigos nem feito um teste de jogo em todas as GPUs. Conteúdo parado pode gerar FPS/bitrate menores sem reduzir a resolução. 1080p60 e bitrate alto ainda dependem do upload de quem transmite, do número de espectadores, do hardware e da qualidade da rede.
