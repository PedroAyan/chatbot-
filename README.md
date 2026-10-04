# Bot de pedidos pelo WhatsApp

Bot determinístico, com menus e comandos, para WhatsApp Business Platform / Cloud API. Não usa inteligência artificial nem conecta pelo WhatsApp Web. Executa em Cloudflare Workers com D1, Queues e um Durable Object para coordenar o processamento.

O código está preparado para configurar um número real. O pacote não contém credenciais nem cria contas, registra números ou publica automaticamente. A ativação depende do número registrado na Meta, das credenciais novas e dos dados reais da empresa.

## 1. Credenciais que já foram expostas

Remover um arquivo do projeto não revoga uma credencial e não apaga versões antigas do GitHub. O arquivo local versionado continha valores de `ADMIN_TOKEN` e `WHATSAPP_VERIFY_TOKEN`; substitua-os caso tenham sido usados. Se outras credenciais também foram publicadas, revogue e gere novos valores na plataforma correspondente. Configure os novos valores somente como segredos.

O ZIP de distribuição não contém `.git`, histórico, `.dev.vars`, `.wrangler` ou `node_modules`. Você pode publicar os arquivos da pasta extraída em um repositório novo, mantendo somente `.dev.vars.example`, com o marcador `insira aqui` nos campos de credenciais.

`.dev.vars`, `.env`, `node_modules` e `.wrangler` estão no `.gitignore`. Se você atualizar o repositório original e esses arquivos já estavam rastreados, retire-os do índice antes de enviar as alterações, por exemplo com `git rm --cached .dev.vars` e `git rm -r --cached node_modules .wrangler`, quando existirem no índice. Isso não limpa o histórico antigo: a revogação das credenciais expostas continua necessária. Limpar o histórico compartilhado exige planejamento próprio; a revogação deve acontecer primeiro.

## 2. Pré-requisitos

- Node.js 24 ou superior e npm.
- Conta Cloudflare com acesso a Workers, D1, Queues e Durable Objects.
- Portfólio empresarial Meta, aplicativo com produto WhatsApp e WhatsApp Business Account (WABA).
- Número empresarial registrado na Cloud API e seu `Phone Number ID`. Esse ID é diferente do telefone e do WABA ID.
- Token de usuário do sistema autorizado para a WABA e o número, com `whatsapp_business_messaging`; use `whatsapp_business_management` quando precisar administrar recursos. Complete os requisitos que a Meta apresentar para o seu aplicativo, número e empresa.
- Template aprovado para avisos fora da janela de atendimento, no idioma configurado.

Use o fluxo oficial de [início da Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started). Um token temporário do painel de desenvolvimento não deve sustentar a operação em produção. Se o número já estiver no aplicativo WhatsApp/WhatsApp Business, confira o fluxo de registro, migração ou coexistência disponível para sua conta antes de alterar o número em uso.

## 3. Instalação e recursos da Cloudflare

Na pasta do projeto:

```powershell
npm ci
npx wrangler login
npx wrangler d1 create whatsapp-restaurante
npx wrangler queues create whatsapp-incoming
npx wrangler queues create whatsapp-failed
```

Copie o `database_id` retornado pelo comando D1 para `wrangler.toml`, substituindo `00000000-0000-0000-0000-000000000000`. Os nomes das filas e os bindings `DB`, `INCOMING_QUEUE` e `COORDINATOR` precisam corresponder ao arquivo. A publicação cria o namespace do Durable Object `RestaurantCoordinator` com a migração SQLite `v1`.

Em um banco **novo**, inicialize as tabelas e aplique a atualização de produção:

```powershell
npm run db:init:remote
npm run db:migrate:remote
```

Em um banco **existente** com o esquema original, preserve os dados, faça um backup e execute a atualização de produção:

```powershell
npx wrangler d1 export whatsapp-restaurante --remote --output=backup-antes-atualizacao.sql
npm run db:migrate:remote
```

O backup contém dados dos clientes: guarde-o fora do Git e dos pacotes de distribuição. Os scripts de atualização usam o SQL explícito `sql/migrations/0001-production.sql`; não dependem de `wrangler d1 migrations apply`. Consulte os [comandos oficiais do D1](https://developers.cloudflare.com/d1/wrangler-commands/).

## 4. Dados da empresa

Edite `[vars]` em `wrangler.toml` antes da publicação:

| Variável | Conteúdo |
| --- | --- |
| `PRODUCTS_JSON` | Catálogo real em JSON. IDs inteiros positivos e únicos, nome e preço em centavos. |
| `BUSINESS_NAME`, `ADDRESS`, `OPENING_HOURS` | Nome, endereço completo e horários reais. Substitua todos os textos `CONFIGURE_...`. |
| `PRIVACY_CONTACT` | Contato real da empresa para solicitações sobre dados pessoais, exibido em `/privacy`. Revise a política para refletir sua operação. |
| `PIX_KEY`, `PIX_RECIPIENT` | Chave PIX empresarial e nome do favorecido, caso aceite PIX. São dados comerciais para recebimento; não são credenciais de uma API. |
| `INTERNAL_NUMBERS` | Telefones autorizados da equipe, separados por vírgulas, somente dígitos com país e DDD. |
| `TIMEZONE` | Fuso IANA da operação; padrão `America/Sao_Paulo`. |
| `DELIVERY_BASE_FEE` | Taxa de entrega em reais, usando ponto decimal. O valor distribuído é `0.00`; configure sua taxa. |
| `DELIVERY_MINUTES` | Estimativa inicial de entrega em minutos. |
| `MENU_URL` | Link HTTPS público do cardápio, se houver. |
| `PAYMENT_PIX_LINK` | Link PIX opcional; não representa confirmação bancária. |
| `WHATSAPP_API_VERSION` | Versão da Graph API; padrão configurável `v23.0`. Verifique o suporte da versão na sua conta antes da ativação. |
| `WHATSAPP_NOTIFICATION_TEMPLATE` | Nome exato do template aprovado. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | Idioma exato aprovado, por exemplo `pt_BR`. |

Exemplo de **formato** de catálogo; substitua o produto e o preço pelos reais:

```toml
PRODUCTS_JSON = '[{"id":1,"name":"Seu produto","priceCents":2500,"category":"food"}]'
```

Há suporte a `food`, `addon`, `drink` e `dessert`, além de opções e pacotes. Não publique produtos e valores de demonstração como oferta real. `PRODUCTS_JSON = '[]'` deixa o catálogo vazio e `ALLOW_DEMO_CATALOG = "false"` impede o uso automático do catálogo de exemplo. JSON inválido produz erro explícito. Sem catálogo real, pedidos ficam indisponíveis.

## 5. Segredos

Cadastre cada segredo pelo prompt interativo do Wrangler; os valores não devem ficar em comandos, arquivos versionados ou capturas de tela:

```powershell
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

| Campo | Qual credencial/identificador | Onde obter ou criar | Para que serve |
| --- | --- | --- | --- |
| `WHATSAPP_TOKEN` | **Access Token da Meta**, autorizado à WABA e ao número; não é uma API key da Cloudflare. | Meta Business Settings > Usuários do sistema. Gere um token apropriado à produção com acesso aos ativos e `whatsapp_business_messaging`; adicione `whatsapp_business_management` quando precisar administrar recursos. | Autenticar envios na Cloud API. |
| `WHATSAPP_PHONE_NUMBER_ID` | **Phone Number ID** do número empresarial; não é o celular nem o WABA ID. | Aplicativo Meta > WhatsApp > Configuração da API. | Identificar o número remetente e validar a origem dos webhooks. |
| `WHATSAPP_APP_SECRET` | **App Secret** do aplicativo Meta. | Meta for Developers > aplicativo > Configurações > Básico > App Secret. | Validar o `X-Hub-Signature-256` e impedir webhooks forjados. |
| `WHATSAPP_VERIFY_TOKEN` | **Verify Token**, segredo criado pelo dono; não é o Access Token. | Gere um valor aleatório em um gerenciador de senhas e repita-o na configuração do webhook Meta. | Autorizar a verificação inicial GET do webhook. |
| `ADMIN_TOKEN` | **Token/senha de acesso do painel**, criado pelo dono. | Gere um segredo longo e aleatório em um gerenciador de senhas. | Login do painel e simulador; acesso administrativo por header. |

`CLOUDFLARE_API_TOKEN` é opcional para automação de publicação/CI e pertence à conta Cloudflare. Para publicação manual, `npx wrangler login` faz a autenticação. Esse token não é exigido pelo bot em execução, não substitui o token WhatsApp e não deve ser colocado no código nem em `[vars]`. Configure-o somente como segredo da plataforma de CI quando usar esse fluxo.

Use um gerenciador de senhas para gerar e guardar os segredos. Substitua `insira aqui` somente no arquivo local não versionado ou nos prompts interativos de segredos. O marcador não é uma credencial válida e é rejeitado pelo aplicativo. A [documentação de segredos do Workers](https://developers.cloudflare.com/workers/configuration/secrets/) distingue o desenvolvimento local da produção: `.dev.vars` serve para execução local e não publica esses valores.

## 6. Publicação e webhook Meta

```powershell
npm run deploy
```

Use a URL HTTPS retornada pelo Wrangler. O aplicativo oferece `/health`, com prontidão e nomes das configurações faltantes, sem revelar seus valores. Uma resposta `503` precisa ser resolvida antes da ativação.

No aplicativo Meta, configure:

1. Callback URL: `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/webhook`.
2. Verify token: exatamente o novo `WHATSAPP_VERIFY_TOKEN` salvo nos segredos.
3. Assinatura do campo `messages` nos webhooks do WhatsApp.
4. Assinatura do aplicativo à WABA usada pelo número; a configuração no painel deve abranger a WABA correta.

A verificação GET devolve o desafio somente com o token correto. Requisições POST exigem assinatura HMAC válida e identificação do número configurado. O corpo inteiro é verificado antes de executar comandos; um telefone escrito em JSON sem assinatura válida não autoriza a equipe.

A confirmação HTTP do webhook significa que o recebimento foi aceito. A fila processa as mensagens depois. Observe a primeira conversa real e seus estados de entrega no painel e nos logs após concluir a configuração; os testes locais não validam o número, as permissões ou a entrega pela Meta.

## 7. Janela de atendimento e templates

Respostas livres podem ser enviadas até 24 horas após a última mensagem **recebida daquele destinatário**. Fora dessa janela, avisos usam o template aprovado configurado. Enviar um template não abre a janela: o destinatário precisa responder. Essas regras e a necessidade de consentimento para contato constam da [política oficial do WhatsApp](https://whatsappbusiness.com/policy/).

Este código suporta um template com **um parâmetro textual no corpo**, sem cabeçalho variável nem botões com parâmetros. Um formato a submeter à Meta é:

> Atualização sobre seu atendimento: {{1}}. Para continuar, responda a esta mensagem.

A Meta decide a aprovação e a categoria conforme o conteúdo e o uso; não há aprovação automática. O aviso inserido em `{{1}}` tem limite de 900 caracteres. Configure o nome e o idioma exatamente como aprovados. Sem template, os avisos fora da janela falham de forma explícita e ficam sujeitos ao tratamento da fila de saída.

Os números de `INTERNAL_NUMBERS` também precisam consentir com os alertas e podem precisar do template fora da janela. A autorização para executar comandos internos não substitui esse consentimento. Obtenha e respeite a permissão de clientes e equipe para as categorias de avisos enviadas, incluindo solicitações de interrupção. Publique os dados de contato e a política de privacidade da empresa antes do uso com clientes.

## 8. Uso pelo cliente e pela equipe

O cliente envia `OI` ou `MENU` para abrir as opções. `0` ou `VOLTAR` sai da seção atual. Pedidos permitem adicionar itens, consultar `CARRINHO`, `REMOVER ID`, `EDITAR`, `FINALIZAR`, escolher entrega/retirada e pagamento, e confirmar. `CANCELAR PEDIDO` descarta o carrinho ainda não confirmado. `ACOMPANHAR PEDIDO` mostra os pedidos registrados. O envio da chave PIX não comprova pagamento: a equipe confere o recebimento.

Reservas: `NOVA RESERVA`, `MINHAS RESERVAS`, `ALTERAR RESERVA ID` e `CANCELAR RESERVA ID`. Datas usam `DD/MM/AAAA HH:MM` no fuso configurado. A solicitação de evento pode começar com `11` ou `EVENTOS`. A lista de espera admite entrada e saída. O cadastro de aniversário registra informações e não cria pontos ou cupons automaticamente.

Comandos de equipe, enviados por um telefone de `INTERNAL_NUMBERS`; o prefixo `/equipe` é opcional:

| Comando | Ação |
| --- | --- |
| `preparando ID`, `pronto ID`, `saiu ID`, `entregue ID` | Atualiza a etapa de um pedido, respeitando entrega ou retirada e a sequência permitida. |
| `esgotado ID`, `disponivel ID` | Bloqueia ou libera um produto por ID no catálogo e na finalização. |
| `cozinha MINUTOS` | Salva a estimativa da cozinha. |
| `assumir ID` | Assume um ticket de atendimento humano. |
| `responder ID mensagem` | Encaminha uma resposta para o cliente do ticket. |
| `concluir ID` | Encerra o atendimento e libera o bot. |
| `chamar ID`, `retirar ID` | Chama ou retira um registro da lista de espera. |
| `confirmar reserva ID` | Confirma uma reserva registrada. |
| `notificar reserva ID mensagem` | Encaminha um aviso sobre uma reserva. |
| `resumo` | Consulta o resumo operacional. |

A opção de atendente cria um ticket e alerta a equipe. Durante o atendimento, novas mensagens ficam anexadas ao ticket até a conclusão. Alertas e respostas são encaminhados para envio; a confirmação do comando não afirma que o destinatário recebeu a mensagem.

## 9. Painel e operação

Abra `/admin`, digite o `ADMIN_TOKEN` e entre. O login usa `POST /admin/session`; o token não vai na URL. A sessão tem cookie `HttpOnly`, `Secure`, `SameSite=Strict` e validade de uma hora. Para acesso programático, use `x-admin-token` ou `Authorization: Bearer ...`. Use HTTPS para que o cookie funcione.

O webhook percorre as mensagens recebidas de cada lote. A fila `whatsapp-incoming` entrega ao consumidor, que usa o coordenador único para processar operações sequencialmente. O D1 guarda entrada processada e fila de saída junto com as alterações de negócio. Reenvios com o mesmo identificador não devem criar outro pedido. O cron de um minuto trata envios pendentes e lembretes; as datas de lembrete são convertidas para UTC a partir do fuso da empresa.

A Cloud API aceita a mensagem antes de confirmar sua entrega. O sistema registra os estados retornados por webhook e as falhas para acompanhamento. O transporte não considera ausência de token como simulação bem-sucedida, tem tempo limite de 15 segundos e não grava o token, corpo de mensagem ou resposta bruta da API nos erros.

Não há garantia de envio exatamente uma vez na API externa: se a Meta aceitar um envio e a confirmação se perder, uma nova tentativa pode repetir o aviso. Textos com mais de 4.096 caracteres são enviados sequencialmente, em até dez partes; uma falha parcial e nova tentativa também pode repetir partes. Mantenha catálogo e respostas compactos.

Monitore falhas e mensagens pendentes com o painel e, quando necessário:

```powershell
npx wrangler tail
```

Após cinco tentativas adicionais de processamento, mensagens que continuam falhando seguem para `whatsapp-failed`. Essa fila não tem consumidor automático neste projeto. Configure monitoramento e recuperação operacional antes de depender dela: mensagens não ficam retidas indefinidamente. Veja [configuração de Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/) e [filas de falha](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/). Não reenvie em massa avisos que já tenham sido entregues.

## 10. Desenvolvimento e validação essencial

Para usar banco local:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run db:init
npm run db:migrate
npm run dev
```

Preencha `.dev.vars` somente com credenciais de desenvolvimento quando realmente precisar da API. O simulador fica desativado por padrão. Para habilitá-lo no ambiente de desenvolvimento, configure `SIMULATOR_ENABLED = "true"` e acesse `/simulator` com autenticação administrativa. Os telefones do simulador usam prefixo `99` e não geram mensagens de saída. Os registros compartilham o banco daquele ambiente; prefira `wrangler dev` com D1 local e mantenha o simulador desativado em produção.

```powershell
npm test
```

O projeto executa somente os dois cenários essenciais pedidos: um fluxo sem ciclo e outro com ciclo. Eles usam banco e transporte controlados localmente; não fazem contato real com clientes. Não há testes exaustivos. A validação do número real exige as credenciais e os recursos da sua conta.

O bot não confirma pagamentos bancários, não integra automaticamente uma cozinha, não determina capacidade física de mesas e não substitui a equipe para orçamentos, alergias ou atendimento humano. O cadastro recebido deve ser tratado pela empresa de acordo com a finalidade informada ao cliente.
