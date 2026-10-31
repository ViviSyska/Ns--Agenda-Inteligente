import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

// Banco de mentira que lembra o que aconteceu (agendamentos + mensagens), para testar conversas de verdade.
function mundo({ ags, historico = [], atrasoGravar = 0 }) {
  const msgs = [...historico]; const sent = [];
  const sock = { sendMessage: async (jid, m) => { const id = 'out' + (msgs.length + 1); sent.push(m.text); msgs.push({ direction: 'out', ts: new Date().toISOString(), wa_id: id, text: m.text }); return { key: { id } }; }, signalRepository: { lidMapping: { getPNForLID: async () => null } } };
  const wa = { getStatus: () => 'open', getSock: () => sock, getQR: () => null, getUser: () => null, logout: async () => {} };
  const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
  const db = {
    listClientes: async () => [{ id: 'c1', nome: 'Ana Souza', whatsapp: '11988887777' }],
    listAguardando: async () => ags.filter((a) => a.wa_status === 'aguardando' && ['pendente', 'confirmado'].includes(a.status)).map((a) => ({ ...a })),
    updateAgendamento: async (id, f) => { await pausa(atrasoGravar); Object.assign(ags.find((a) => a.id === id), f); },
    listChatMessages: async () => [...msgs].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
    insertMessage: async (m) => { msgs.push({ direction: m.direction, ts: m.ts, wa_id: m.wa_id, text: m.text }); },
  };
  const api = createApp({ cfg: { apiKey: 'x', corsOrigin: '*', delayMinMs: 0, delayMaxMs: 0, maxBulk: 5, waitOpenMs: 0, autoReply: true, replyConfirmou: 'Confirmado {data} {hora}', replyRecusou: 'Anotado {data} {hora}' }, db, wa, log: { info() {}, warn() {}, error() {} }, sleep: async () => {} });
  let n = 0;
  const diz = (texto, ts) => api.handleIncoming({ key: { remoteJid: '5511988887777@s.whatsapp.net', id: 'IN' + ++n, fromMe: false }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.parse(ts) / 1000) });
  return { api, ags, diz, sent, msgs };
}
const ag = (id, data, extra = {}) => ({ id, cliente_id: 'c1', data, hora: '14:00', status: 'pendente', wa_status: 'aguardando', wa_enviado_em: '2026-10-30T12:00:00Z', ...extra });

test('confirmou com "sim" e logo depois (mesmo segundo) manda "não": não muda mais nada', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31')] });
  await w.diz('sim', '2026-10-30T13:00:00Z');
  await w.diz('não', '2026-10-30T13:00:00Z');
  assert.equal(w.ags[0].wa_status, 'confirmou'); assert.equal(w.ags[0].status, 'confirmado');
});

test('confirmou e minutos depois manda "não": continua confirmado', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31')] });
  await w.diz('sim', '2026-10-30T13:00:00Z');
  await w.diz('não', '2026-10-30T13:05:00Z');
  assert.equal(w.ags[0].wa_status, 'confirmou');
});

test('mandou "não" e depois "sim": continua como Faltou (a primeira resposta vale)', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31')] });
  await w.diz('não', '2026-10-30T13:00:00Z');
  await w.diz('sim', '2026-10-30T13:02:00Z');
  assert.equal(w.ags[0].wa_status, 'recusou'); assert.equal(w.ags[0].status, 'pendente');
});

test('duas mensagens coladas ("sim" e "não" ao mesmo tempo): só a primeira vale', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31')], atrasoGravar: 30 });
  await Promise.all([w.diz('sim', '2026-10-30T13:00:00Z'), w.diz('não', '2026-10-30T13:00:00Z')]);
  assert.equal(w.ags[0].wa_status, 'confirmou');
});

test('dois horários em dias diferentes: responder "sim" e depois "não" não mexe no segundo', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31'), ag('a2', '2026-11-07')] });
  await w.diz('sim', '2026-10-30T13:00:00Z');
  await w.diz('não', '2026-10-30T13:05:00Z');
  assert.deepEqual(w.ags.map((a) => a.wa_status), ['confirmou', 'aguardando']);
});

test('lembrete antigo (sem horário gravado): "sim" e depois "não" não mexe', async () => {
  const w = mundo({ ags: [ag('a1', '2026-10-31', { wa_enviado_em: null }), ag('a2', '2026-11-07', { wa_enviado_em: null })],
    historico: [{ direction: 'out', ts: '2026-10-30T12:00:00Z', wa_id: 'L1', text: 'lembrete' }] });
  await w.diz('sim', '2026-10-30T13:00:00Z');
  await w.diz('não', '2026-10-30T13:05:00Z');
  assert.deepEqual(w.ags.map((a) => a.wa_status), ['confirmou', 'aguardando']);
});
