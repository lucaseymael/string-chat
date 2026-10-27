# String Chat 1.6.1 — estados de voz visíveis

- Microfone mutado e áudio recebido silenciado agora têm indicadores separados na lista do canal, nos cartões dos participantes e na visualização central da call.
- Ao silenciar todo o áudio da chamada, o app mostra microfone e fone riscados e o texto **Microfone e áudio silenciados**. O fone riscado indica que a pessoa desativou a escuta da chamada no app.
- Os estados são atualizados para os outros participantes e chegam corretamente a quem entra depois.
- O botão de silenciar áudio também mostra o fone riscado quando ativo. Nas conversas privadas/Amigos, a faixa da call exibe o estado e permite reativar o áudio.
- Reativar a escuta preserva a escolha anterior do microfone: quem já estava mutado continua mutado.
- O mute local de um participante continua privado ao ouvinte; não é anunciado como se o outro usuário tivesse desativado o próprio microfone ou a escuta.
- Os controles da faixa da call se ajustam a janelas menores.

Verificação: testes unitários dos estados, sete cenários desktop com três perfis isolados e regressão das funções de voz/conversa da 1.6. Nenhuma mensagem de uma conta real foi usada nos testes.
