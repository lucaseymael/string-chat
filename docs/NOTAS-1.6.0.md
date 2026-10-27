# String Chat 1.6.0

Esta versão melhora o controle da voz e a leitura das conversas, com implementação própria e RNNoise aberto. Atualize todos os computadores da chamada com o novo setup; o perfil e os históricos são preservados.

- Selecione o microfone e ajuste o ganho de 0 a 200% em Configurações → Voz e dispositivos.
- Use sensibilidade automática ou manual, confira o limiar no teste e desative a detecção de voz se ela cortar alguma palavra.
- Ative/desative a redução de graves e o ajuste automático de volume. Um limitador contém picos causados pelo aumento de ganho.
- O RNNoise agora informa sua probabilidade de voz ao detector. O processamento permanece local e não usa um serviço de IA externo.
- Regule ou silencie a voz de cada pessoa pelo cartão na call. Esse controle não muda o volume do compartilhamento de tela.
- Indicadores de fala refletem o áudio recebido dos participantes.
- Use a busca no histórico carregado de canais e conversas privadas, ou Ctrl+F. A pesquisa aceita texto sem acentos e nomes de anexos.
- Canais exibem contadores de mensagens não lidas. Mensagens novas preservam a posição de quem está lendo acima no histórico.

A supressão de ruído usa RNNoise local. O resultado depende do microfone e do ambiente.

Continuam disponíveis: grupos com canais, DMs, amigos, webcam, imagens/GIFs, tela com meta 1080p60, bitrate de até 50 Mbps por espectador, áudio de tela que exclui a chamada, temas, bandeja e atalhos globais de mutar/ensurdecer.
