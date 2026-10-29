# Servidor WhatsApp (Baileys) — NS Agenda Inteligente

Envia **todos os lembretes de uma vez** (fila no servidor, pausa aleatória de 3–7 s entre mensagens)
e **registra sozinho o Sim/Não** das clientes no campo `wa_status` da agenda.
Feito para o plano **grátis do Render** (dorme quando ninguém usa) — a sessão do WhatsApp fica no
Supabase, então ao acordar ele reconecta **sem escanear o QR de novo**.

## 1) Supabase (uma vez)
SQL Editor → cole e rode `baileys-server/setup.sql`.
Pegue em *Project Settings → API*: a **URL** e a chave **service_role** (secreta — só vai no Render, nunca no index.html).

## 2) Render (uma vez)
1. render.com → **New → Blueprint** → escolha o repositório `Ns--Agenda-Inteligente` (usa o `render.yaml`).
   (ou *New → Web Service*, Root Directory `baileys-server`, Build `npm install --omit=dev`, Start `npm start`, plano Free.)
2. Preencha as variáveis: `API_KEY` (invente uma senha longa), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
3. Aguarde o deploy e anote a URL (ex.: `https://ns-whatsapp.onrender.com`).

## 3) Conectar o WhatsApp (uma vez)
Abra `https://SUA-URL.onrender.com/qr?key=SUA_API_KEY` → no celular: WhatsApp → Aparelhos conectados → Conectar → escaneie.
**Use um número só do salão** (envio automático tem risco de bloqueio).

## 4) No sistema
Configurações → WhatsApp: URL = a do Render, Instância = `salao`, API Key = a mesma `API_KEY` → Salvar → **Testar conexão** (deve dar “open”).
Depois é só: Lembretes → selecionar → **Enviar Lembretes (Todos Selecionados)**.

## 5) Acordar o servidor só quando precisa (grátis)
No Render grátis o servidor dorme após ~15 min sem acesso. Em **cron-job.org** crie um job que chama
`https://SUA-URL.onrender.com/health` a cada 10 min, **somente sexta 18h → sábado 23:59**.
Fora disso ele dorme (custo zero). Se abrir o sistema com ele dormindo, o 1º envio pode demorar ~1 min para acordar.

## Como funcionam as respostas
- Só são capturadas respostas de quem recebeu o lembrete (`wa_status = 'aguardando'`), sempre da data mais próxima.
- “Sim / confirmo / ok / 👍” → `confirmou` (agendamento vira *confirmado*). “Não / cancela / não posso” → `recusou` (vira *cancelado*).
- A cliente recebe uma resposta automática de agradecimento (`AUTO_REPLY=false` desliga).
- Respostas enviadas enquanto o servidor dorme costumam chegar quando ele reconecta; mantenha o pinger ligado até sábado.

## Variáveis opcionais
Veja `.env.example` (`DELAY_MIN_MS`, `DELAY_MAX_MS`, `MAX_BULK`, `REPLY_CONFIRMOU`, `REPLY_RECUSOU`, `CORS_ORIGIN`…).

## Desenvolvimento
`npm install && npm test` (20 testes). Rodar local: `API_KEY=x SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm start`.
