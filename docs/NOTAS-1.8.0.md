# String Chat 1.8.0

Esta versão acrescenta colaboração e uma opção de servidor próprio ao aplicativo desktop. A primeira abertura continua na página Amigos, sem criar grupo nem capturar áudio ou vídeo.

- Chamadas privadas de voz/vídeo: toque, aceite, recusa, cancelamento e sala temporária restrita às duas identidades.
- Respostas, edição, exclusão, reações, fixação e digitação em canais e conversas privadas. Confirmações e reenvios não duplicam mensagens.
- Categorias, cargos, permissões por canal e modo lento. Gerenciamento com formulários e confirmações dentro do app.
- Apelidos, mover participantes, timeout, expulsão, banimento e mute/escuta impostos pela administração. Os estados aparecem para as outras pessoas e são aplicados na reprodução de áudio.
- Presença disponível/ausente/não perturbe/invisível, texto de status, bloqueio e notificações desktop opcionais.
- Servidor HTTPS opcional com diretório, amizades aceitas, mensagens privadas cifradas na fila offline e grupos que permanecem disponíveis quando o criador sai. Os grupos salvos são apresentados na página inicial, com entrada explícita.
- Identidades assinadas, chaves próprias por amizade, proteção contra repetição e autorização aplicada pelo coordenador/servidor. Um participante não recebe histórico nem anexos de canais que não pode ler.

O P2P por LAN/Radmin permanece disponível. Voz, tela e webcam usam WebRTC entre participantes; este servidor não é um retransmissor de mídia. Para redes externas, STUN/TURN pode ser necessário. Não há atualização automática pela internet: execute o novo setup em todos os computadores.

Amizades anteriores sem identidade verificada precisam de novos códigos e aceite; o histórico local é conservado. Perfis, convites, certificados e dados de uso não fazem parte da publicação.

Veja [o guia](COMO-USAR.md), [hospedagem](HOSPEDAGEM.md) e [a verificação desta versão](VERIFICACAO-1.8.md).
