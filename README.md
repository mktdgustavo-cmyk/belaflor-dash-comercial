# Dash Comercial — Hubla + TMB em tempo real

Dash de vendas que se atualiza sozinho a cada venda:

- **Geral**: meta geral, meta comercial, quanto já foi alcançado de cada uma, ranking do time e a lista de vendas das duas plataformas juntas (com filtro Hubla / TMB / vendedor(a) / busca).
- **Vendedores**: escolhe a pessoa (ex.: Jéssica) e vê as vendas dela, a distância até as faixas (mínimo 120 · ótimo 150 · extraordinário 180), as vendas de hoje, a média por dia, o ritmo necessário e quais vendas ela puxou.
- **Config** (só admin): metas, período da campanha, faixas, códigos de UTM de cada vendedor(a), status das planilhas, URLs dos webhooks e log dos últimos webhooks (com o payload bruto).

Stack: Node 22 + Express + SQLite embutido (`node:sqlite`, sem dependência nativa). Front sem build. Atualização ao vivo por Server-Sent Events.

---

## Como a venda vai pra cada vendedor(a)

Ordem de prioridade:

1. **Ajuste manual** (admin troca no select da lista de vendas)
2. **UTM**: se qualquer `utm_source / utm_content / utm_term / utm_medium / utm_campaign` (ou `src`/`sck`) tiver o nome da pessoa (ex.: `utm_content=isla`, `utm_source=comercial-jessica`) ou um dos "Códigos UTM" cadastrados em Config
3. Campo `vendedor` que a TMB manda no webhook (se vier preenchido)
4. **Planilha** da pessoa (pasta "Rastreamento de vendas TMB | COMERCIAL …"): procura o **e-mail** da compradora, depois o **telefone** (compara os últimos 8 dígitos, então tanto faz DDD, +55 ou o 9 extra)

Se o mesmo contato estiver na planilha de duas pessoas, a venda fica com quem cadastrou primeiro e aparece o aviso **"conflito na planilha"** na lista, pra você resolver no manual.

**Sugestão de padrão de link pro comercial:** `...?utm_source=comercial&utm_content=NOME` (ex.: `utm_content=jessica`). Acento e maiúscula não importam.

---

## Deploy no Easypanel (via GitHub)

1. Suba esta pasta num repositório no GitHub (pode ser privado).
2. No Easypanel: **+ Service → App** → Source **GitHub** → escolha o repo e a branch. Build: **Dockerfile** (já está na raiz).
3. **Mounts** → adicione um **Volume** com mount path **`/app/data`** (é onde fica o banco; sem isso perde as vendas a cada deploy).
4. **Environment**: cole as variáveis (modelo em `.env.example`):

   | Variável | Obrigatória | O que é |
   |---|---|---|
   | `ADMIN_PASSWORD` | sim | senha de admin (Config, ajustar vendas) |
   | `VIEW_PASSWORD` | não | senha pro time ver o dash. Vazio = abre pra quem tiver o link |
   | `SESSION_SECRET` | sim | qualquer texto aleatório longo |
   | `HUBLA_TOKEN` | recomendado | Hubla Token (vem no header `x-hubla-token`) |
   | `TMB_TOKEN` | recomendado | valor da chave que você cadastrar no webhook da TMB |
   | `DRIVE_FOLDER_ID` | sim* | ID da pasta do Drive (o trecho depois de `/folders/` no link) |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | sim* | JSON da conta de serviço (inteiro ou em base64) |
   | `SYNC_INTERVAL_SECONDS` | não | de quanto em quanto tempo relê as planilhas (padrão 120) |

5. **Domains**: aponte um domínio/subdomínio, porta **3000**. Deploy.
6. Entre no dash, clique na engrenagem ⚙ e faça login com a `ADMIN_PASSWORD` → **Config** → preencha metas e datas da campanha.

---

## Ligar as planilhas (conta de serviço Google) — ~5 min

1. [console.cloud.google.com](https://console.cloud.google.com) → crie/escolha um projeto.
2. **APIs e serviços → Biblioteca**: ative **Google Drive API** e **Google Sheets API**.
3. **IAM e administrador → Contas de serviço → Criar**. Não precisa dar papel nenhum.
4. Na conta criada: **Chaves → Adicionar chave → JSON**. Baixa um arquivo `.json`.
5. Cole o conteúdo inteiro desse arquivo na variável `GOOGLE_SERVICE_ACCOUNT_JSON` no Easypanel.
6. **Compartilhe a pasta do Drive** com o e-mail da conta de serviço (algo como `dash@projeto.iam.gserviceaccount.com`) como **Leitor**. O e-mail aparece também em Config → Planilhas.
   - A pasta é da Ludmila: se você não conseguir compartilhar, peça pra ela adicionar esse e-mail.

O dash lê **todas** as planilhas da pasta, tira o nome da pessoa do título (`… | COMERCIAL JÉSSICA` → Jéssica) e cria a vendedora sozinho. Planilha nova na pasta = vendedora nova no dash. As colunas podem vir fora de ordem ou faltando (ex.: sem e-mail): ele reconhece e-mail, telefone, data e HUBLA/TMB pelo conteúdo.

**Alternativa sem Google Cloud (Apps Script):** crie um Web App no script.google.com com a conta que tem acesso à pasta, que devolva `{sheets:[{id,name,rows}]}` em JSON, e preencha `SHEETS_SCRIPT_URL` (+ `SHEETS_SCRIPT_KEY`, enviada como `?key=`).

**Alternativa com planilhas abertas:** deixe as planilhas como "qualquer pessoa com o link pode ver" e use
`PUBLIC_SHEETS=Ana=ID_DA_PLANILHA;Isla=ID_DA_PLANILHA;...` no lugar das duas variáveis acima.

---

## Configurar os webhooks

**Hubla** → Integrações → Webhooks → Adicionar regra
- URL: `https://SEU-DOMINIO/webhook/hubla`
- Produtos/ofertas: os da campanha (ou todos)
- Eventos: **Fatura: pagamento realizado (v2)** e **Fatura reembolsada (v2)**
- Copie o **Hubla Token** pra variável `HUBLA_TOKEN`

**TMB** → produto → Integrações → Webhook de **Vendas**
- URL: `https://SEU-DOMINIO/webhook/tmb`
- Chave: `x-webhook-token` · Valor: o mesmo texto de `TMB_TOKEN`
- Conta como venda quando `status_pedido = Efetivado` (boleto de entrada pago). `Cancelado` tira da conta.

Duplicados são ignorados (Hubla pelo id da fatura, TMB pelo número do pedido). No parcelamento inteligente da Hubla só a 1ª parcela conta como venda. Tudo que chega fica no log em Config → "Últimos webhooks recebidos" (com o payload), então dá pra ver na hora se a UTM está vindo.

**Só a campanha:** se Hubla/TMB tiverem outros produtos rodando, preencha em Config "Só contar produtos que contenham" (ex.: `black`).

---

## Importar vendas que já aconteceram

Config → **Importar vendas antigas**: escolha Hubla ou TMB e suba o arquivo exportado da plataforma (**XLSX ou CSV**). O dash detecta as colunas sozinho (nº do pedido/fatura, status, nome, e-mail, telefone, produto, valor, data e UTMs), mostra uma prévia pra conferir e importa.

- Mesmo nº de pedido/fatura não duplica, então dá pra reimportar sem medo, inclusive depois que os webhooks já estiverem ligados.
- Pendentes/expiradas são ignoradas; canceladas e reembolsadas entram, mas não contam.
- Um arquivo antigo nunca reativa uma venda que já foi cancelada depois.

## Testar na mão

```bash
# venda TMB que deve cair pra Isla pela UTM
curl -X POST https://SEU-DOMINIO/webhook/tmb -H 'Content-Type: application/json' \
  -H 'x-webhook-token: SEU_TMB_TOKEN' \
  -d '{"pedido":1,"status_pedido":"Efetivado","cliente":"Teste","email":"teste@teste.com","valor_principal":397,"lancamento":"Teste","utm_content":"isla"}'
```

Depois, logado como admin, clique em **Ignorar** nessa venda na lista da página Geral (ou mande o mesmo pedido com `"status_pedido":"Cancelado"`).

## Rodar local

```bash
npm install
ADMIN_PASSWORD=123 npm run dev   # http://localhost:3000
```
