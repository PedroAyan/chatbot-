# Pedidos pelo WhatsApp

## Configuração

Em wrangler.toml, preencha PRODUCTS_JSON com os produtos reais. Cada produto precisa de id inteiro positivo único, name e priceCents (preço em centavos).

Exemplo de formato, apenas ilustrativo:
PRODUCTS_JSON = '[{"id":1,"name":"Seu produto","priceCents":2500}]'

Preencha PIX_KEY com a chave da empresa e PIX_RECIPIENT com o nome do favorecido. DELIVERY_BASE_FEE é a taxa em reais (atualmente 6). Retirada não cobra taxa.

Configure INTERNAL_NUMBERS com os telefones autorizados da equipe, separados por vírgulas, com código do país e DDD. Apenas esses números entram no fluxo interno. Também são necessários o banco D1 e os segredos de WhatsApp já usados pelo projeto.

Sem produtos ou chave PIX, o bot não conclui novos pedidos. Os exemplos dos testes não são produtos reais.

## Cliente

Envie PEDIDOS ou 4. Adicione itens por número: 1, 1, 2 ou 2x1 e 1x2. CARRINHO mostra o resumo. REMOVER 1 remove todas as unidades do produto 1. FINALIZAR pergunta o endereço ou RETIRADA. CONFIRMAR registra o pedido e envia o total e a chave PIX. EDITAR volta aos itens. CANCELAR PEDIDO descarta o carrinho ainda não confirmado. Voltar ao menu com 0 também encerra o carrinho atual.

Envie 5 ou ACOMPANHAR PEDIDO para consultar os últimos pedidos. O envio da chave não confirma o pagamento: a equipe deve conferir o recebimento. Não há QR Code nem confirmação bancária automática.

## Equipe

Use preparando 123 (ou /equipe preparando 123), depois saiu 123 para entrega ou pronto 123 para retirada. Finalize com entregue 123. O bot valida a sequência, salva o status e envia o aviso ao cliente. Atualizar status não altera a situação do pagamento. Se o envio do aviso falhar, o status permanece salvo e a equipe recebe a orientação de avisar manualmente.

A primeira situação é Pedido registrado. A consulta não promete atualização automática pela cozinha. Não há integração com sistema de cozinha ou banco.

## Validação

npm test executa somente dois cenários: fluxo sem ciclo (compra, entrega, PIX e avisos simulados) e fluxo com ciclo (editar carrinho, remover produto e retirada).

As alterações são locais. Para usá-las no número real, configure os dados e publique o Worker pelo processo habitual do projeto.
