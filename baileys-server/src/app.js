// API HTTP do servidor WhatsApp + lógica de envio em lote e captura de respostas.
// Compatível com os endpoints da Evolution API que o sistema já usa
// (connectionState e sendText), mais o envio em lote (sendBulk).
import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { toWaNumber, phoneKey, jidToPhone } from './phone.js';
import { parseReply, extractText } from './reply-parser.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENTES_TTL_MS = 5 * 60 * 1000;

const fmtDataBR = (iso) => {
  const [y, m, d] = String(iso || '').substring(0, 10).split('-');
  return y && m && d ? `${d}/${m}` : '';
};
const joinHoras = (horas) =>
  horas.length <= 1 ? horas[0] || '' : `${horas.slice(0, -1).join(', ')} e ${horas[horas.length - 1]}`;
const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''));
  const B = Buffer.from(String(b ?? ''));
  return A.length === B.length && timingSafeEqual(A, B);
}

/**
 * @param {object} deps
 * @param {object} deps.cfg   apiKey, corsOrigin, delayMinMs, delayMaxMs, maxBulk, waitOpenMs, autoReply, replyConfirmou, replyRecusou
 * @param {object} deps.db    listClientes(), listAguardando(ids), updateAgendamento(id, fields)
 * @param {object} deps.wa    getStatus(), getSock(), getQR(), getUser(), logout()
 * @param {object} [deps.log]
 * @param {Function} [deps.sleep]
 */
export function createApp({ cfg, db, wa, log = console, sleep = defaultSleep }) {
  const app = express();
  app.disable('x-powered-by');

  // ---------- CORS + JSON ----------
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', cfg.corsOrigin || '*');
    res.set('Access-Control-Allow-Headers', 'apikey, content-type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const auth = (req, res, next) => {
    if (!safeEqual(req.get('apikey') || req.query.key, cfg.apiKey)) {
      return res.status(401).json({ error: 'apikey_invalida', message: 'API key inválida' });
    }
    next();
  };

  // ---------- envio ----------
  async function waitOpen(ms) {
    const t0 = Date.now();
    while (wa.getStatus() !== 'open') {
      if (Date.now() - t0 >= ms) return false;
      await sleep(250);
    }
    return true;
  }

  async function sendOne(number, text) {
    const sock = wa.getSock();
    if (!sock || wa.getStatus() !== 'open') return { ok: false, error: 'whatsapp_desconectado' };
    const num = toWaNumber(number);
    if (!num) return { ok: false, error: 'numero_invalido' };
    try {
      let jid = `${num}@s.whatsapp.net`;
      const found = await sock.onWhatsApp(num);
      if (Array.isArray(found)) {
        const hit = found.find((r) => r.exists);
        if (!hit) return { ok: false, error: 'numero_sem_whatsapp' };
        jid = hit.jid;
      } // se a consulta falhou (undefined), tenta enviar direto
      const res = await sock.sendMessage(jid, { text });
      return { ok: true, jid, id: res?.key?.id };
    } catch (e) {
      return { ok: false, error: 'falha_envio', detail: String(e?.message || e) };
    }
  }

  async function sendWithRetry(number, text) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await sendOne(number, text);
      if (r.ok || r.error === 'numero_invalido' || r.error === 'numero_sem_whatsapp') return r;
      if (r.error === 'whatsapp_desconectado') await waitOpen(cfg.waitOpenMs);
      else await sleep(2000);
    }
    return r;
  }

  // ---------- fila de lotes ----------
  const jobs = new Map();
  const queue = [];
  let working = false;

  const randomDelay = () => cfg.delayMinMs + Math.random() * Math.max(0, cfg.delayMaxMs - cfg.delayMinMs);

  function trimJobs() {
    while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
  }

  async function runQueue() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const { job, item } = queue.shift();
        const r = await sendWithRetry(item.number, item.text);
        if (r.ok) {
          item.status = 'enviado';
          job.sent++;
          if (item.agId) {
            try {
              await db.updateAgendamento(item.agId, { wa_status: 'aguardando' });
            } catch (e) {
              item.dbError = String(e?.message || e);
              log.error?.({ err: item.dbError, agId: item.agId }, 'falha ao marcar aguardando');
            }
          }
        } else {
          item.status = 'falhou';
          item.error = r.error;
          job.failed++;
          log.warn?.({ error: r.error, name: item.name }, 'mensagem do lote falhou');
        }
        if (job.sent + job.failed >= job.total) {
          job.status = 'concluido';
          job.finishedAt = new Date().toISOString();
        }
        if (queue.length) await sleep(randomDelay());
      }
    } finally {
      working = false;
    }
  }

  function enqueue(messages) {
    const job = {
      id: randomUUID(),
      status: 'enviando',
      total: messages.length,
      sent: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      items: [],
    };
    const rejected = [];
    for (const m of messages) {
      const item = { name: m.name || '', number: m.number, text: String(m.text ?? ''), agId: m.agId || null, status: 'na_fila' };
      if (!toWaNumber(m.number) || !item.text.trim()) {
        item.status = 'falhou';
        item.error = !item.text.trim() ? 'texto_vazio' : 'numero_invalido';
        job.failed++;
        rejected.push({ name: item.name, error: item.error });
      } else {
        queue.push({ job, item });
      }
      job.items.push(item);
    }
    if (job.sent + job.failed >= job.total) {
      job.status = 'concluido';
      job.finishedAt = new Date().toISOString();
    }
    jobs.set(job.id, job);
    trimJobs();
    runQueue().catch((e) => log.error?.({ err: String(e) }, 'fila quebrou'));
    return { job, rejected };
  }

  // ---------- rotas ----------
  const health = (_req, res) =>
    res.json({ ok: true, service: 'ns-baileys-server', state: wa.getStatus(), uptime: Math.round(process.uptime()) });
  app.get('/', health);
  app.get('/health', health);

  app.get('/instance/connectionState/:inst', auth, (req, res) => {
    res.json({ instance: { instanceName: req.params.inst, state: wa.getStatus() }, user: wa.getUser() });
  });

  app.get('/instance/connect/:inst', auth, async (_req, res) => {
    const qr = wa.getQR();
    res.json({ state: wa.getStatus(), base64: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 320 }) : null });
  });

  app.post('/instance/logout/:inst', auth, async (_req, res) => {
    try {
      await wa.logout();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'falha_logout', message: String(e?.message || e) });
    }
  });

  app.get('/qr', auth, async (req, res) => {
    const state = wa.getStatus();
    const qr = wa.getQR();
    const user = wa.getUser();
    let body;
    if (state === 'open') {
      body = `<h2>✅ WhatsApp conectado</h2><p>${user?.id ? 'Número: ' + String(user.id).split(':')[0].split('@')[0] : ''}</p>`;
    } else if (qr) {
      const img = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      body = `<h2>Escaneie com o WhatsApp</h2><p>Celular → ⋮ → Dispositivos conectados → Conectar dispositivo</p><img alt="QR" src="${img}" width="320" height="320">`;
    } else {
      body = `<h2>⏳ Aguardando o servidor gerar o QR…</h2><p>Estado: ${state}</p>`;
    }
    const refresh = state === 'open' ? '' : '<meta http-equiv="refresh" content="4">';
    res
      .type('html')
      .send(
        `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>WhatsApp — NS Agenda</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:32px;background:#111;color:#fff}img{background:#fff;padding:8px;border-radius:12px}</style></head><body>${body}</body></html>`,
      );
  });

  // Envio único (compatível com a Evolution API) — usado pelo relatório diário.
  app.post('/message/sendText/:inst', auth, async (req, res) => {
    const { number, text } = req.body || {};
    if (!number || !text) return res.status(400).json({ error: 'dados_invalidos', message: 'number e text são obrigatórios' });
    if (!(await waitOpen(cfg.waitOpenMs))) {
      return res.status(503).json({ error: 'whatsapp_desconectado', state: wa.getStatus() });
    }
    const r = await sendWithRetry(number, String(text));
    if (!r.ok) return res.status(r.error === 'falha_envio' ? 502 : 400).json({ error: r.error, detail: r.detail });
    res.status(201).json({ key: { id: r.id, remoteJid: r.jid }, status: 'PENDING' });
  });

  // Envio em lote: o sistema manda a lista toda de uma vez e o servidor cuida do resto.
  app.post('/message/sendBulk/:inst', auth, async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages?.length) return res.status(400).json({ error: 'dados_invalidos', message: 'messages[] é obrigatório' });
    if (messages.length > cfg.maxBulk) {
      return res.status(400).json({ error: 'lote_grande', message: `Máximo de ${cfg.maxBulk} mensagens por lote` });
    }
    if (!(await waitOpen(cfg.waitOpenMs))) {
      return res.status(503).json({
        error: 'whatsapp_desconectado',
        state: wa.getStatus(),
        message: 'WhatsApp desconectado — abra /qr no servidor para reconectar.',
      });
    }
    const { job, rejected } = enqueue(messages);
    const queued = job.total - rejected.length;
    const avgMs = (cfg.delayMinMs + cfg.delayMaxMs) / 2 + 1500;
    res.status(202).json({
      ok: true,
      jobId: job.id,
      queued,
      rejected,
      estimateMin: Math.max(1, Math.ceil((queued * avgMs) / 60000)),
    });
  });

  app.get('/message/jobs/:inst/:jobId', auth, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job_nao_encontrado' });
    res.json({
      id: job.id,
      status: job.status,
      total: job.total,
      sent: job.sent,
      failed: job.failed,
      items: job.items.map((i) => ({ name: i.name, status: i.status, error: i.error || null })),
    });
  });

  // ---------- respostas Sim/Não ----------
  let clientesCache = { at: 0, list: [] };
  async function findClientes(key) {
    const find = () => clientesCache.list.filter((c) => phoneKey(c.whatsapp) === key);
    if (Date.now() - clientesCache.at > CLIENTES_TTL_MS) clientesCache = { at: Date.now(), list: await db.listClientes() };
    let hit = find();
    if (!hit.length && Date.now() - clientesCache.at > 15000) {
      // cliente cadastrada há pouco: atualiza a lista uma vez
      clientesCache = { at: Date.now(), list: await db.listClientes() };
      hit = find();
    }
    return hit;
  }

  async function resolvePhone(msg) {
    const k = msg.key || {};
    let phone = jidToPhone(k.remoteJid) || jidToPhone(k.remoteJidAlt) || jidToPhone(k.participantAlt);
    if (!phone && String(k.remoteJid || '').endsWith('@lid')) {
      try {
        const pn = await wa.getSock()?.signalRepository?.lidMapping?.getPNForLID(k.remoteJid);
        phone = jidToPhone(pn);
      } catch (e) {
        log.warn?.({ err: String(e) }, 'não consegui converter LID em telefone');
      }
    }
    return phone;
  }

  /** Processa uma mensagem recebida. Retorna { handled, reason?, verdict?, updated? } */
  async function handleIncoming(msg) {
    const jid = msg?.key?.remoteJid || '';
    if (!msg?.message || msg.key?.fromMe) return { handled: false, reason: 'ignorada' };
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
      return { handled: false, reason: 'grupo_ou_lista' };
    }
    const verdict = parseReply(extractText(msg.message));
    if (!verdict) return { handled: false, reason: 'nao_e_resposta' };

    const phone = await resolvePhone(msg);
    const key = phone && phoneKey(phone);
    if (!key) return { handled: false, reason: 'telefone_desconhecido', verdict };

    const clientes = await findClientes(key);
    if (!clientes.length) return { handled: false, reason: 'cliente_nao_encontrada', verdict };

    const aguardando = await db.listAguardando(clientes.map((c) => c.id));
    if (!aguardando.length) return { handled: false, reason: 'sem_agendamento_aguardando', verdict };

    // confirma/cancela o(s) horário(s) mais próximo(s) — todos os do mesmo dia
    const dia = String(aguardando[0].data).substring(0, 10);
    const alvos = aguardando.filter((a) => String(a.data).substring(0, 10) === dia);
    for (const ag of alvos) {
      const fields = { wa_status: verdict };
      if (verdict === 'confirmou' && ag.status === 'pendente') fields.status = 'confirmado';
      if (verdict === 'recusou' && (ag.status === 'pendente' || ag.status === 'confirmado')) fields.status = 'cancelado';
      await db.updateAgendamento(ag.id, fields);
    }

    if (cfg.autoReply) {
      const cli = clientes.find((c) => c.id === alvos[0].cliente_id) || clientes[0];
      const texto = fillTemplate(verdict === 'confirmou' ? cfg.replyConfirmou : cfg.replyRecusou, {
        nome: String(cli?.nome || '').split(' ')[0],
        data: fmtDataBR(dia),
        hora: joinHoras(alvos.map((a) => a.hora)),
      });
      try {
        await wa.getSock()?.sendMessage(jid, { text: texto });
      } catch (e) {
        log.warn?.({ err: String(e) }, 'não consegui enviar a resposta automática');
      }
    }
    return { handled: true, verdict, updated: alvos.map((a) => a.id), dia };
  }

  return { app, handleIncoming, enqueue, sendOne, _jobs: jobs };
}
