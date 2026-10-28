# String Chat 1.8 — amigos, conversas privadas e grupos

**Atualizem todos os computadores para a versão 1.8.0.** Fechem a versão antiga antes de abrir o novo programa. Amizades antigas sem identidade verificada precisam trocar novos códigos e confirmar novamente; seu histórico é preservado.

## Instalar e atualizar

Execute **StringChat-Setup-1.8.0.exe** em todos os PCs da chamada. O setup verifica o pacote, fecha o app instalado, instala a versão nova e só depois remove as versões anteriores reconhecidas. O perfil e as conversas salvas são preservados. Reexecutar o setup da mesma versão repara arquivos. O programa aparece em **Aplicativos instalados** do Windows para desinstalar.

As próximas atualizações usam o mesmo processo: abra o setup novo. O launcher e os atalhos apontam para a versão instalada atual. A limpeza é das versões instaladas reconhecidas; cópias portáteis guardadas em outras pastas não são apagadas. Se você tinha fixado um executável antigo na barra de tarefas, fixe o novo atalho String Chat após esta migração.

## Temas, ícone e bandeja

Em **Configurações → Tema do aplicativo**, escolha **Escuro · azul e cinza** ou **Claro · azul e cinza claro** e salve. A escolha permanece ao reabrir. A primeira abertura usa o escuro. Vídeos e imagens mantêm suas cores. O novo ícone é um headset.

O ícone da bandeja oferece **Abrir String Chat**, microfone, áudio recebido e **Sair do String Chat**. O X encerra por padrão. Para manter chamadas e mensagens em segundo plano, ative **Continuar na bandeja ao clicar no X**. Com a opção ligada, use **Sair** na bandeja para encerrar de verdade.

## Atalhos globais

Os padrões são **Ctrl + Shift + M** para mutar/reativar o microfone e **Ctrl + Shift + D** para silenciar/reativar o áudio recebido e pausar/restaurar o microfone. Eles funcionam também com a janela em segundo plano ou minimizada.

Em **Configurações → Atalhos de teclado**, clique em **Definir**, pressione a combinação e salve. **Remover** desativa esse atalho. Se outro programa já usa a mesma combinação, escolha outra: o app informa o conflito. Os atalhos usam a API [globalShortcut do Electron](https://www.electronjs.org/docs/latest/api/global-shortcut).

## Som, atraso e resolução

- O padrão prioriza manter a resolução. Em **Se a conexão ficar limitada**, você pode escolher manter fluidez e permitir reduzir resolução.
- O bitrate continua em até **25 Mbps por espectador** por padrão, ajustável até **50 Mbps**. Não é uma taxa constante: cenas paradas podem usar menos.
- As trilhas de áudio têm prioridade sobre o vídeo. As estatísticas mostram codec, filas de áudio/vídeo e custo de codificação.
- Se uma fonte ficar sem som, confira o volume enviado, o volume do player e o estado de áudio. Use **Recuperar áudio** no player local; falhas transitórias também recebem tentativa automática de recuperação.
- O som dos apps continua separado do microfone e exclui o áudio do próprio String Chat. Quando o Windows não oferece a captura segura, o app informa a limitação.
- Em **Ajuda → Salvar diagnóstico deste PC**, salve um relatório para relatar uma falha. Não inclui o conteúdo de conversas nem códigos de convite.

## Sua página inicial

O programa abre em **Amigos**, sem entrar ou criar grupo. Canais, participantes e controles da call aparecem apenas quando você cria ou entra em um grupo. A página inicial também é usada nas próximas aberturas; grupos não são reconectados automaticamente ao reiniciar.

## Conversar em privado

1. Em **Adicionar amigo**, envie seu código ou cole o código do amigo. O outro usuário precisa aceitar o pedido.
2. Em **Amigos**, clique em **Conversar**, ou escolha o contato na lista **Mensagens diretas**.
3. Envie texto, emojis, imagens, GIFs ou arquivos de até **8 MB**. Clique numa imagem para ampliar e use **Salvar** para guardar o arquivo.
4. **Entregue** significa que o programa do amigo confirmou o recebimento. Em P2P, quando o amigo está offline, aparece **Não entregue**; clique em **Tentar novamente** quando ele voltar. Com ambos no servidor opcional, aparece **Na fila do servidor** até ele receber automaticamente.

As conversas privadas não passam pelo criador nem pelos participantes dos grupos. Cada amizade usa uma chave própria para proteger as mensagens durante o envio. O histórico é salvo localmente nos dois PCs; os arquivos e o histórico privado ficam separados dos grupos. O armazenamento local não recebe criptografia adicional em disco.

No modo P2P, os dois precisam estar com o String Chat aberto na mesma rede Radmin/LAN para entregar novas mensagens. O histórico já recebido pode ser lido com o amigo offline. A indicação **Entregue** não é uma confirmação de leitura.

Nas ações da mensagem, use **Responder**, **Editar**, **Excluir**, **Reagir** ou **Fixar**. Alterações de mensagens privadas offline aguardam confirmação do amigo e mostram esse estado. Uma exclusão recebida não desfaz cópias que alguém já tenha salvo.

Para ligar sem grupo, abra a conversa privada e use o botão de voz ou vídeo. O amigo precisa aceitar; o toque não liga microfone ou câmera. Encerre a chamada/grupo atual antes de iniciar outra chamada privada. A webcam continua exigindo a autorização local.

## Presença e privacidade

No painel de amigos, escolha **Disponível**, **Ausente**, **Não perturbe** ou **Invisível** e escreva um status opcional. Invisível publica offline e oculta seu texto de status; não perturbe mantém a entrega sem alertas sonoros. Você pode bloquear, desbloquear ou remover contatos. Depois de desbloquear, um novo pedido precisa ser aceito para retomar a amizade.

Notificações do Windows e prévia de mensagens são opcionais nas configurações. Elas vêm desligadas; o conteúdo só é mostrado se você permitir.

## Servidor próprio opcional

Em **Configurações → Seu servidor, seus amigos**, informe o endereço HTTPS e o token de cadastro fornecidos pelo administrador. O token só é necessário na primeira conexão da identidade e não é salvo nas preferências. A conexão automática é opcional e não entra em chamadas ou grupos.

Em **Adicionar amigo**, o diretório permite procurar pessoas cadastradas no mesmo servidor. Pedidos continuam exigindo aceite. Para criar um grupo hospedado, escolha **Servidor próprio** na rede do novo grupo. Os grupos dos quais você faz parte aparecem na página inicial; **Entrar** abre o grupo sem ligar seu microfone automaticamente.

O administrador deve preparar o serviço conforme [HOSPEDAGEM.md](HOSPEDAGEM.md). Não é preciso servidor para continuar usando P2P. A mídia continua direta e pode exigir STUN/TURN em redes externas; hospedar o serviço de mensagens não garante conectividade de áudio/vídeo em todo tipo de NAT.

Você pode abrir uma conversa privada enquanto continua na call de um grupo. Uma faixa indica a chamada ativa e oferece **Ver chamada**, microfone, câmera e **Sair da voz**. Voltar para Amigos não desconecta a chamada. Uma nova abertura do programa sempre começa sem call.

O histórico privado conserva até 200 mensagens por conversa, com limite global de 2.000 mensagens e 128 MB em anexos privados. Conteúdo já entregue mais antigo é removido ao atingir os limites; envios e alterações ainda pendentes são protegidos, com limite próprio para não crescer indefinidamente.

## Criar e entrar no grupo

1. Abram o **Radmin VPN** e entrem na mesma rede.
2. No String Chat, clique em **Convidar amigos**, escolha o nome do grupo e confirme **Criar grupo e copiar convite**. A rede Radmin é selecionada automaticamente quando detectada.
3. Envie o link copiado para todos os amigos. O mesmo convite serve para o grupo inteiro; não há mais códigos de resposta.
4. O amigo clica no link para abrir o programa e entrar, ou usa **Entrar em um grupo** e cola o convite.
5. Depois que o grupo existe, **Convidar amigos** copia o convite em um clique.

No P2P, o criador precisa manter o programa aberto. Se o Windows perguntar, permita o String Chat no Firewall para a rede usada pelo Radmin. Não é necessário desativar o Firewall nem contratar hospedagem. O grupo hospedado continua no servidor quando o criador sai.

## Canais e chamada

- Clique em um **canal de texto** para abrir o chat na área principal.
- Clique em um **canal de voz** para entrar e expandir a call e as transmissões desse canal.
- O criador pode adicionar canais nos botões **+** das listas de texto e voz.
- O botão de desligar a call sai **só da voz** em um grupo: você continua por texto. Numa chamada privada, ele encerra a chamada inteira.
- **Sair do grupo** fica abaixo do nome do grupo. No P2P, se o criador sair, o grupo fica indisponível até ele abri-lo novamente. Grupos hospedados permanecem no servidor.
- **Gerenciar grupo** oferece categorias, canais, cargos, permissões e membros conforme suas permissões. Canais podem ter descrição, modo lento e regras de leitura/envio/reação/conexão por cargo.
- Administradores podem mover, silenciar, impedir escuta, aplicar timeout, expulsar ou banir membros respeitando a hierarquia. Um mute administrativo não pode ser removido pelo botão local do participante.

Os canais têm áudio separado. Quem está em outro canal de voz não recebe o microfone ou a tela do seu canal. O P2P admite até seis pessoas por grupo, com até 24 canais. O serviço hospedado tem limites maiores para texto e até seis pessoas por canal de voz.

## Webcam e foto de perfil

- No canal de voz, clique no **botão de câmera**, ao lado dos controles de áudio. Na primeira vez, confirme **Permitir câmera**. Clique novamente para desligar.
- A webcam funciona junto com a tela: vídeo separado em até **720p30**, com limite de **3 Mbps por amigo**, além do bitrate da tela. Ela só é enviada ao seu canal de voz. Sair da voz desliga a webcam.
- Em **Configurações → Webcam**, escolha o dispositivo se tiver mais de uma câmera. A prévia local é espelhada; seus amigos recebem a imagem sem espelhar.
- Para mudar a foto, abra **Configurações → Escolher foto**, selecione a imagem e clique em **Salvar configurações**. O centro da imagem é recortado para uma foto quadrada e estática. **Remover** volta às iniciais após salvar.
- A foto fica salva no PC e aparece nos participantes, mensagens e amigos. A câmera sempre inicia desligada ao abrir o programa.

## Tela e volumes

Escolha **Compartilhar tela** e confirme uma tela ou janela no seletor do programa. A meta continua sendo **1080p60**, com **25 Mbps por amigo** como padrão e ajuste até **50 Mbps**.

Quem assiste pode regular o **volume de cada transmissão no próprio player**, sem alterar as vozes. Quem transmite pode mudar **Volume enviado na transmissão** nas configurações, alterando o som que todos recebem.

O vídeo usa toda a área disponível sem uma barra fixa embaixo. Mova o mouse sobre a transmissão para mostrar volume, nome e botão de tela cheia; os controles somem após alguns segundos sem interação. Também podem ser acessados pelo teclado. O modo de tela cheia mantém a proporção da imagem. Ao capturar um monitor que mostra o próprio String Chat, a imagem pode se repetir porque o aplicativo está sendo capturado. Para evitar esse efeito, selecione a janela do jogo/vídeo, outro monitor ou deixe o app fora da área capturada.

O Windows exclui o som do próprio String Chat da captura dos outros aplicativos, evitando devolver as vozes da call e os sons de notificação no áudio da tela. Se essa exclusão não estiver disponível, a imagem continua e o áudio do sistema é bloqueado, com aviso. Use fones para evitar retorno acústico pelo microfone.

## Imagens, GIFs, arquivos e emojis

As imagens aparecem sem moldura. Clique na imagem para abrir a visualização ampliada. Use **Ampliar** ou clique na foto para alternar o zoom, **Salvar** para baixar e **Esc**, **×** ou o fundo para fechar. GIFs continuam animados.

- **+** no chat: enviar imagem ou arquivo de até **8 MB**.
- **GIF**: escolher e enviar um GIF animado do PC.
- **☺**: abrir a seleção de emojis.
- Também pode arrastar um arquivo para o chat ou colar uma imagem com **Ctrl+V**.
- O botão **Salvar** de um anexo permite escolher onde guardá-lo.

No P2P, o histórico recente fica no computador do criador: até 200 mensagens e 128 MB de anexos por grupo. No modo hospedado, fica no servidor sob limites de armazenamento definidos pelo administrador. Os GIFs são enviados como arquivo; não há busca em catálogo externo.

## Amigos

Abra **Amigos** na barra esquerda. Copie **Meu código de amigo** e envie, ou cole o código recebido para enviar um pedido. A outra pessoa aceita o pedido no mesmo painel.

Os amigos ficam salvos. O painel mostra presença/status e permite **Convidar** para o seu grupo. Em P2P, **Entrar** usa o grupo compartilhado por um amigo online; os dois precisam de conectividade pela rede Radmin/LAN. No servidor opcional, use o diretório e os convites de grupo nas conversas. O status pode levar alguns segundos para atualizar.

## Sons e microfone

Há sons distintos para cliques, entrada e saída da voz e mensagens recebidas. Nas configurações, ajuste **Sons do programa** ou desative-os.

A supressão **RNNoise neural local** continua disponível, com cancelamento de eco separado e teste do microfone.

## Limites da conexão

No P2P, o programa usa a interface Radmin/LAN escolhida e o criador coordena canais, convites, texto e arquivos. No modo hospedado, o servidor assume essa coordenação. A mídia usa WebRTC entre os participantes em ambos os modos.

FPS e bitrate reais dependem da rede e do hardware. A 25 Mbps para três amigos, reserve até 75 Mbps de upload mais áudio e protocolos. Consulte **Estatísticas** para ver os valores reais.

## Atualizar o programa

Execute **StringChat-Setup-1.8.0.exe** em todos os PCs. O perfil, a foto e o histórico são mantidos. Amizades antigas sem identidade verificada precisam trocar novos códigos e confirmar novamente. Convites e códigos começam com **stringchat://**. Não apague os dados do aplicativo para atualizar.


## Voz e conversas na versão 1.6

Em Configurações → Voz e dispositivos, escolha o microfone, ganho, redução de graves e sensibilidade. Ouvir teste permite conferir o resultado antes de salvar. O filtro é RNNoise local. Desative a detecção de voz se ela cortar alguma palavra e reduza o ganho se houver aviso de picos.

Nos cartões da call, regule o volume ou silencie uma pessoa apenas para você. O som da tela tem controle independente. Canais e DMs têm busca no histórico carregado (Ctrl+F), inclusive sem acentos e por nome do anexo. Canais mostram contadores de não lidas.


## Indicadores de microfone e escuta

Microfone riscado indica microfone mutado. Fone riscado indica que a pessoa desativou o áudio recebido da chamada; nesse estado o microfone também fica pausado, e os dois ícones aparecem riscados. Os indicadores ficam na lista do canal, nos cartões e na visualização central, e são atualizados para os outros participantes.

Em Amigos ou numa DM, use o botão de fone na faixa da chamada para silenciar ou reativar o áudio. Ao reativar, o microfone retorna à escolha anterior. Silenciar uma pessoa apenas para você, pelo cartão, não muda o status dela para os outros.

## Novos controles de chamada — 1.7

Em **Configurações → Modo de voz e reprodução**:

- Escolha **Pressionar para falar** e **Definir** para gravar sua combinação de teclas. O padrão é F8. Segure para transmitir e solte para fechar, inclusive com o app minimizado. O botão de microfone continua sendo o mute principal. Atalhos de mutar e silenciar áudio devem ser diferentes do PTT.
- **Avisar quando eu falar com o microfone mutado** mostra um aviso e toca um som se houver fala sustentada. É necessário já ter ativado o mic nesta chamada; o aviso não inicia a captura. O aviso não é usado em PTT ou com a escuta desativada.
- Selecione o **fone ou alto-falante de saída**. A seleção vale para as vozes, som da tela, teste do mic e sons do app. Se a saída desaparecer, o app tenta voltar ao padrão do Windows.
- Ative **Baixar a transmissão enquanto alguém fala** e escolha a redução. O volume volta suavemente depois; seu ajuste de volume do player é preservado.
- **Áudio espacial** libera um controle esquerda/direita no cartão de cada pessoa. Use fones estéreo. O som da tela mantém seus canais estéreo e não é espacializado.

No player de uma transmissão, mova o mouse para ver **Qualidade desta transmissão**. Escolha origem/1080p, 720p, 480p ou somente áudio. Cada pessoa escolhe sua própria qualidade; o limite de bitrate definido por quem transmite continua valendo. Não há aumento artificial de resolução ou FPS acima da captura original. Os dois apps precisam estar na versão 1.7 para confirmar a escolha.

**Recuperar vídeo** tenta retomar a mesma captura sem encerrar a voz ou o som da tela. Uma segunda tentativa pode renegociar VP8 para contornar problemas do codec. Há limites de tentativas para evitar reinicializações contínuas. A recuperação automática atua quando um vídeo visível para de receber quadros; problemas de rede persistentes ainda exigem corrigir a conexão.

Em **Sincronia da transmissão**, deixe **Menor atraso** e **Sem correção** como ponto de partida. Buffer equilibrado/estável pode ajudar redes irregulares, acrescentando atraso. Se o som chega antes da imagem, use uma correção positiva para atrasar o áudio. Se chega depois, use negativa para atrasar a imagem. O ajuste é local, manual e não altera a voz. O buffer é uma preferência do WebRTC, sem garantia de um atraso exato.

**Desfocar o fundo da câmera neste PC** usa MediaPipe e um modelo incluído no instalador, sem enviar quadros a um serviço de processamento. Ative a câmera normalmente depois de salvar. O efeito custa processamento e pode diminuir os FPS da webcam; não muda o FPS configurado para a tela. A segmentação pode falhar nas bordas e não substitui verificar o que aparece na câmera.
