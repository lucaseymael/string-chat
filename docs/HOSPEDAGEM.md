# Servidor próprio opcional

O modo P2P continua disponível. O servidor próprio acrescenta diretório de identidades, pedidos de amizade, presença e uma fila persistente de envelopes de mensagens privadas. Ele guarda as chaves públicas e os pacotes cifrados; as chaves privadas de identidade e os segredos de cada amizade permanecem nos computadores dos participantes.

## Preparar o serviço

Use Node.js 22.12 ou mais recente e uma máquina que possa permanecer ligada. Coloque o código do projeto nessa máquina. A infraestrutura usa módulos nativos do Node; o serviço de hospedagem não precisa iniciar o Electron.

Providencie um domínio e certificado TLS válido para ele. A chave privada TLS pertence ao administrador do servidor e serve à conexão HTTPS; ela não é uma chave privada da conta de um participante. Guarde a chave, o token de cadastro, a pasta de dados e suas cópias de segurança fora do repositório público.

Exemplo no Windows:

```powershell
node scripts/hosted-server.mjs --data C:\StringChatData --cert C:\StringChatTLS\fullchain.pem --key C:\StringChatTLS\private-key.pem --host 0.0.0.0 --port 8443
```

Exemplo no Linux:

```sh
node scripts/hosted-server.mjs --data /var/lib/stringchat --cert /etc/stringchat/fullchain.pem --key /etc/stringchat/private-key.pem --host 0.0.0.0 --port 8443
```

Sem `--host`, o serviço escuta apenas em `127.0.0.1`. Abra somente a porta escolhida no Firewall e execute o serviço com uma conta de poucos privilégios. Um proxy reverso pode fornecer HTTPS na porta 443; mantenha o caminho de API `/v1/` e limite o tamanho e o tempo das solicitações. Para encaminhar a um serviço HTTPS interno, configure também a verificação do certificado do destino no proxy.

O token inicial é lido da variável `STRINGCHAT_REGISTRATION_TOKEN`. Na ausência dela, o serviço cria `registration-token.txt` dentro da pasta de dados e não escreve seu conteúdo nos logs. O token precisa ter pelo menos 24 caracteres e só é necessário para cadastrar uma identidade nova. Uma identidade cadastrada volta a autenticar com assinaturas da chave privada local. Renovar o token de cadastro não troca nem apaga contas existentes.

## Identidade e entrega

Solicitações HTTP são assinadas com Ed25519, incluindo método, caminho, hash do corpo, horário e nonce. O servidor rejeita alterações, repetição e troca de identidade. As relações de amizade exigem aceite do destinatário; bloqueios impedem pedidos e novos envelopes e retiram a fila daquela relação.

Mensagens privadas usam o segredo X25519 da amizade e AEAD. O envelope que atravessa a fila também é assinado pelo remetente. A confirmação de armazenamento no servidor significa **na fila**, e não **entregue**. A entrega só é concluída quando chega uma confirmação autenticada do computador do destinatário.

O servidor conhece metadados necessários ao roteamento: contas, relações de amizade, horários, remetente, destinatário e tamanho dos pacotes. As filas não são um mecanismo de anonimato. O armazenamento local do aplicativo não ganha criptografia adicional de disco; proteja o perfil do sistema operacional.

## Limites e operação

- Padrão: até 1.000 contas, 64 relações de amizade por conta, 2.000 envelopes e 64 MiB na fila de cada destinatário, com limite global de 100.000 envelopes e 512 MiB. O índice de confirmações tem limite de 100.000 registros; ao atingir o limite, novas confirmações aguardam a expiração dos registros antigos e as mensagens permanecem na fila.
- Um arquivo continua limitado a 8 MB nos clientes. Ele atravessa o transporte em pacotes pequenos; o servidor limita o pacote cifrado e a fila, sem precisar abrir o conteúdo.
- A retenção padrão da fila é de sete dias. Ela não substitui backup nem garante armazenamento permanente.
- A presença expira sem atividade recente; o estado invisível publica offline e omite o texto de status. Não perturbe mantém a entrega, com eventos locais silenciosos.
- A sinalização de chamadas privadas usa o segredo da amizade em um domínio criptográfico separado. O toque expira em até 30 segundos e a confirmação da fila não atende a chamada. Câmera e microfone dependem da aceitação explícita e das permissões locais.
- O cache de nonces rejeita novos pedidos ao atingir sua capacidade, preservando a proteção contra repetição dos pedidos ainda válidos. O padrão limita esse cache a 100.000 entradas no total e 4.096 por identidade; o limite HTTP é de 2.400 pedidos por minuto por endereço de rede.
- Não há retransmissão de mídia no serviço de mensagens. Voz, câmera e tela ainda dependem da conectividade WebRTC entre os participantes e, em algumas redes, de STUN/TURN configurados separadamente.

Faça backup consistente da pasta de dados com o serviço parado, incluindo `state.json`, `hosted-mail` e o token de cadastro protegido. Guarde também certificados/configuração em local seguro. O serviço rejeita estado inválido e preserva o arquivo para investigação; não o apaga automaticamente.

O cliente verifica a cadeia TLS e o nome do certificado. Não há opção global para aceitar certificados inválidos. Os testes locais fornecem uma CA de teste explicitamente e verificam também uma impressão digital SHA-256 adicional. Não reutilize certificados ou senhas dos testes em produção.

## Usar no aplicativo

Em **Configurações → Seu servidor, seus amigos**, informe a origem HTTPS, como `https://chat.example.com:8443`, e o token na primeira conexão de cada perfil. Para uma CA privada administrada por você, use **Certificado de confiança** antes de conectar. O certificado importado é público; nunca selecione a chave privada TLS. Certificados vencidos ou com nome incorreto continuam recusados.

A opção **Conectar automaticamente** só reconecta a conta ao serviço: não entra em grupo nem liga dispositivos. O token de cadastro é temporário e não fica nas preferências. Após conectar, **Adicionar amigo** oferece a busca de identidades no servidor e os pedidos continuam dependendo de aceite.

Para criar um grupo hospedado, escolha **Servidor próprio** na rede do convite. Configure `--public-url https://chat.example.com:8443` no serviço para fixar a origem pública dos convites. Grupos salvos aparecem na página inicial e exigem clique em **Entrar**. Cargos, permissões, histórico e arquivos permanecem disponíveis sem o PC do criador; chamadas privadas usam salas temporárias de duas identidades, sem aparecer na lista de grupos.

Mensagens privadas são cifradas de ponta a ponta. Grupos hospedados usam TLS em trânsito, mas seu histórico e anexos são legíveis pelo administrador e ficam no disco do servidor. Faça backup também de `groups.json` e `hosted-groups/`, junto de `state.json`, `hosted-mail/`, token e configuração. Grupos têm limites próprios de membros/armazenamento; voz usa malha P2P com até seis pessoas por canal. Não foi validado como serviço público sob carga.

Veja `node scripts/hosted-server.mjs --help`. Os testes HTTPS em `tests/hosted-services.mjs` usam somente loopback e dados efêmeros. A infraestrutura não foi ensaiada como serviço público de grande escala.
