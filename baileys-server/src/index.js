import pino from 'pino';
import { createApp } from './app.js';
import { createDb, createSupabase } from './db.js';
import { createWhatsApp } from './whatsapp.js';
import { createReativacao } from './reativacao.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    log.fatal(`Variável de ambiente obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return v;
};
const num = (name, def) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== undefined ? Number(process.env[name]) : def);

const cfg = {
  apiKey: need('API_KEY'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  delayMinMs: num('DELAY_MIN_MS', 3000),
  delayMaxMs: num('DELAY_MAX_MS', 7000),
  maxBulk: num('MAX_BULK', 150),
  waitOpenMs: num('WAIT_OPEN_MS', 45000),
  autoReply: (process.env.AUTO_REPLY ?? 'true') !== 'false',
  replyConfirmou:
    process.env.REPLY_CONFIRMOU || 'Perfeito, {nome}! Sua presença está confirmada para {data} às {hora}. Te esperamos! 💛',
  replyRecusou:
    process.env.REPLY_RECUSOU ||
    'Tudo bem, {nome}! Anotamos que você não vai poder vir em {data} às {hora}. Quando quiser remarcar é só chamar. 💛',
};
const session = process.env.WA_SESSION || 'salao';

const sb = createSupabase(need('SUPABASE_URL'), need('SUPABASE_SERVICE_KEY'));
const db = createDb(sb);

// `wa` e `api` se referenciam: o handler de mensagens só roda depois que ambos existem.
let api;
const wa = createWhatsApp({
  sb,
  session,
  log,
  onMessage: (m) =>
    api.handleIncoming(m).then((r) => {
      if (r.handled) log.info({ verdict: r.verdict, ags: r.updated }, 'resposta registrada');
      else if (r.reason !== 'ignorada' && r.reason !== 'nao_e_resposta' && r.reason !== 'grupo_ou_lista') {
        log.info({ reason: r.reason }, 'resposta não aplicada');
      }
    }),
});
api = createApp({ cfg, db, wa, log });

const reat = createReativacao({ db, wa, sendOne: (n, t) => api.sendOne(n, t), log, salaoId: process.env.SALAO_ID || null });
const reatTimer = setInterval(() => reat.tick().catch((e) => log.error({ err: String(e?.message || e) }, 'reativação falhou')), 10 * 60 * 1000);
reatTimer.unref();

const port = num('PORT', 3000);
const server = api.app.listen(port, () => log.info(`Servidor WhatsApp ouvindo na porta ${port}`));
wa.start().catch((e) => log.error({ err: String(e) }, 'falha ao iniciar WhatsApp'));

const shutdown = () => {
  log.info('encerrando…');
  wa.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log.error({ err: String(e) }, 'unhandledRejection'));
