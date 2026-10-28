# Recursos e arquitetura — String Chat

String Chat é um aplicativo desktop para conversar, reunir amigos e compartilhar telas por P2P ou com servidor próprio opcional. A identidade visual, os sons e os controles são próprios do projeto. Esta tabela descreve o escopo implementado; não é uma promessa de equivalência total com outra plataforma.

## Recursos disponíveis

| Área | Recursos |
| --- | --- |
| Espaço pessoal | Amigos, pedidos de amizade, presença personalizada, bloqueio, busca privada e mensagens sem entrar em grupo |
| Grupos | Convites reutilizáveis, canais de texto e voz, até seis participantes |
| Conversas | Texto formatado, imagens, GIFs, emojis, arquivos de até 8 MB, busca, não lidas, respostas, edição/exclusão, reações, fixação e digitação |
| Administração | Categorias, cargos, permissões por canal, modo lento, apelidos, timeout, mover, expulsar, banir e controle administrativo de mute/escuta |
| Chamadas privadas | Toque, aceite, recusa, cancelamento e sala de duas identidades sem alterar os grupos salvos |
| Servidor próprio | HTTPS, diretório de amigos, filas privadas cifradas offline, confirmação do destinatário e grupos sempre disponíveis |
| Voz | RNNoise local, cancelamento de eco, ganho, limitador, sensibilidade e redução de graves |
| Controles | Mute do mic, silenciar toda a escuta, estados visíveis e atalhos globais |
| Entrada e saída | Seleção de microfone, troca de saída e teste local do microfone |
| PTT | Tecla global mantida, soltura e fechamento seguro se o monitor da tecla parar |
| Reprodução | Volume e mute por pessoa, atenuação opcional da tela e posicionamento espacial das vozes |
| Tela | Meta 1080p60, limite configurável de até 50 Mbps por espectador, qualidade individual e somente áudio |
| Recuperação e sincronia | Recuperação de vídeo, alternativa VP8, preferência de buffer e correção manual de áudio/imagem |
| Webcam | Vídeo separado da tela e desfoque local opcional com MediaPipe |
| Desktop | Temas claro/escuro, foto de perfil, sons, bandeja e setup de atualização |

## Processamento local

O microfone usa captura mono de 48 kHz, cancelamento de eco do navegador, filtro de graves opcional, RNNoise, detector de atividade e ganho com limitação de picos. PTT adiciona uma autorização temporária dentro do processamento de áudio. Se as atualizações da tecla cessarem, a saída volta ao silêncio.

A segmentação de webcam usa um worker, runtime MediaPipe e modelo incluídos no instalador. Não utiliza um serviço remoto para processar quadros. As trilhas de microfone, tela, som da tela e câmera permanecem separadas.

O áudio de aplicativos é capturado pelo loopback por processo do Windows, excluindo a árvore de processos do próprio String Chat. As vozes e os sons do app não são reenviados como parte da transmissão. O retorno acústico no microfone ainda depende do uso de fones e do ambiente.

## Rede e limites

O computador que cria o grupo coordena os canais, convites e histórico recente. A mídia usa WebRTC entre participantes. Cada espectador exige upload do transmissor. Conexão direta depende de conectividade LAN/Radmin e das permissões do Firewall.

No modo P2P, os dois participantes precisam estar online e alcançáveis para entregar DMs novas. No modo hospedado, o servidor encaminha envelopes cifrados e conserva grupos, permissões, histórico e anexos; as chaves privadas das contas ficam nos clientes. Dados de grupos são acessíveis ao administrador do servidor. A mídia permanece WebRTC entre participantes, com até seis pessoas por canal de voz. STUN/TURN externo pode ser necessário. Veja [hospedagem](HOSPEDAGEM.md).

Ainda não há fóruns/threads, enquetes, eventos agendados, soundboard, bots/webhooks, catálogo externo de GIFs, aplicativos móveis ou sobreposição em jogos. Essas áreas exigem desenvolvimento e testes adicionais.

FPS, bitrate e atraso reais dependem da captura, do conteúdo, do hardware e da rede. A supressão pode reduzir ruído, mas não garante separar outras pessoas falando ao fundo. Desfoque consome CPU e pode falhar nas bordas da segmentação.

Veja [o guia](COMO-USAR.md), [as notas 1.8](NOTAS-1.8.0.md) e [os testes e seus limites](VERIFICACAO-1.8.md). Componentes externos e licenças estão em `vendor/THIRD-PARTY-LICENSES.txt`; a origem dos arquivos de segmentação está em `vendor/mediapipe/SOURCES.json`.
