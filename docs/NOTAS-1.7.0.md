# String Chat 1.7.0

Esta versão acrescenta controles de voz, reprodução e vídeo ao app desktop P2P.

A interface também foi renovada: espaço de trabalho com cantos suaves, superfícies em azul e cinza, hierarquia de texto mais clara, cartões de amigos e controles consistentes nos temas claro e escuro. Os controles da transmissão continuam aparecendo ao mover o mouse, preservando a imagem inteira.

- **PTT global:** tecla mantida e soltura real, inclusive minimizado. Monitor nativo acompanha apenas a combinação configurada. O processamento de áudio fecha a transmissão caso as atualizações da tecla parem.
- **Aviso de fala mutada:** alerta local após fala sustentada, sem ativar captura por conta própria.
- **Qualidade por espectador:** origem/1080p, 720p, 480p e somente áudio, com confirmação do transmissor e preservação do limite de upload escolhido por ele.
- **Reprodução:** seleção da saída, atenuação opcional do som da tela durante fala e posição espacial individual das vozes. Volume local, mute por pessoa e mute total continuam separados.
- **Sincronia:** preferência de buffer e correção manual entre −300 e +300 ms; zero mantém o caminho sem correção adicional. Atrasar a imagem usa uma fila limitada em memória.
- **Vídeo:** recuperação manual/automática limitada e alternativa VP8 na segunda tentativa, preservando a captura de tela e sua trilha de áudio.
- **Webcam:** desfoque opcional com segmentação local MediaPipe. O modelo e o runtime vêm no pacote, com licença e origem registradas.
- **Correções:** fechamento do teste de mic durante sua inicialização, retorno da tecla de PTT após interrupção do monitor, retorno à saída padrão e saída de tela cheia por Esc.

O mixer usa diretamente as trilhas WebRTC recebidas. Os elementos de vídeo ficam sem reprodução própria de áudio, evitando reprodução duplicada; a transmissão mantém o som separado das vozes e sem espacialização.

Instale **StringChat-Setup-1.7.0.exe** em todos os PCs. O setup preserva o perfil e remove versões instaladas anteriores reconhecidas somente após concluir a atualização. Para a versão portátil, extraia o ZIP em uma pasta nova e mantenha seus arquivos juntos.

A meta de tela continua 1080p60, com padrão de 25 Mbps por espectador e ajuste até 50 Mbps. Rede, hardware, conteúdo e captura original determinam o resultado real. Os testes locais não comprovam desempenho em dois PCs distantes ou no Radmin do usuário.

A supressão de ruído usa RNNoise local, com licenças de distribuição preservadas.

Veja [como usar](COMO-USAR.md) e [verificação](VERIFICACAO-1.7.md).
