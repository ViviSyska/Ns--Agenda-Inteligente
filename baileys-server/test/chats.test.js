import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { describeMessage } from '../src/reply-parser.js';

const silent = { info() {}, warn() {}, error() {} };
const cfg = { apiKey: 'k', corsOrigin: '*', delayMinMs: 0, delayMaxMs: 0, maxBulk: 5, waitOpenMs: 0, autoReply: false };
const H = { 'content-type': 'application/json', apikey: 'k' };

function setup() {
  const rows = [];
  const sent = [];
  const sock = {
    onWhatsApp: async (n) => [{ jid: `${n}@s.whatsapp.net`, exists: true }],
    sendMessage: async (jid, m) => { sent.push({ jid, text: m.text }); return { key: { id: 'out' + sent.length } }; },
  };
  const wa = { getStatus: () => 'open', getSock: () => sock, getQR: () => null, getUser: () => null, logout: async () => {} };
  const db = {
    listClientes: async () => [{ id: 'c1', nome: 'Josi Evelyn', whatsapp: '(11) 99999-1111' }],
    listAguardando: async () => [],
    updateAgendamento: async () => {},
    insertMessage: async (r) => { if (r.wa_id && rows.some((x) => x.wa_id === r.wa_id)) return; rows.push({ id: String(rows.length + 1), ...r }); },
    listRecentMessages: async () => [...rows].sort((a, b) => b.ts.localeCompare(a.ts)),
    listChatMessages: async (k) => rows.filter((r) => r.chat_key === k).sort((a, b) => a.ts.localeCompare(b.ts)),
    markChatRead: async (k) => { rows.forEach((r) => { if (r.chat_key === k && r.direction === 'in') r.lida = true; }); },
  };
  const api = createApp({ cfg, db, wa, log: silent, sleep: async () => {} });
  return { api, rows, sent };
}
const serve = async (app) => {
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
};
const incoming = (text, id, extra = {}) => ({
  key: { remoteJid: '5511999991111@s.whatsapp.net', fromMe: false, id },
  message: { conversation: text }, messageTimestamp: 1793400000, pushName: 'Josi', ...extra,
});

test('mensagem recebida vira conversa, com nome da cliente e não lida', async () => {
  const { api, rows } = setup();
  await api.handleIncoming(incoming('Oi, posso remarcar?', 'A1'));
  await api.handleIncoming(incoming('Oi, posso remarcar?', 'A1')); // repetida: ignora
  assert.equal(rows.length, 1);
  const s = await serve(api.app);
  try {
    const j = await (await fetch(`${s.base}/chats/salao`, { headers: H })).json();
    assert.equal(j.unread, 1);
    assert.equal(j.chats[0].nome, 'Josi Evelyn');
    assert.equal(j.chats[0].last.text, 'Oi, posso remarcar?');
    const m = await (await fetch(`${s.base}/chats/salao/${j.chats[0].key}/messages`, { headers: H })).json();
    assert.equal(m.messages.length, 1);
    await fetch(`${s.base}/chats/salao/${j.chats[0].key}/read`, { method: 'POST', headers: H });
    assert.equal((await (await fetch(`${s.base}/chats/salao`, { headers: H })).json()).unread, 0);
  } finally { s.close(); }
});

test('responder usa o endereço da cliente e guarda a resposta no histórico', async () => {
  const { api, rows, sent } = setup();
  await api.handleIncoming(incoming('Bom dia', 'B1'));
  const key = rows[0].chat_key;
  const s = await serve(api.app);
  try {
    const r = await fetch(`${s.base}/chats/salao/${key}/send`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'Bom dia! Claro 💛' }) });
    assert.equal(r.status, 201);
    assert.deepEqual(sent, [{ jid: '5511999991111@s.whatsapp.net', text: 'Bom dia! Claro 💛' }]);
    assert.equal(rows.at(-1).direction, 'out');
    assert.equal((await fetch(`${s.base}/chats/salao/${key}/send`, { method: 'POST', headers: H, body: '{}' })).status, 400);
    assert.equal((await fetch(`${s.base}/chats/salao`)).status, 401);
  } finally { s.close(); }
});

test('o que você manda pelo celular entra como saída; grupos e reações são ignorados', async () => {
  const { api, rows } = setup();
  await api.handleIncoming(incoming('Pode vir às 10h', 'C1', { key: { remoteJid: '5511999991111@s.whatsapp.net', fromMe: true, id: 'C1' } }));
  await api.handleIncoming({ key: { remoteJid: '1203@g.us', id: 'G1' }, message: { conversation: 'oi grupo' } });
  await api.handleIncoming({ key: { remoteJid: '5511999991111@s.whatsapp.net', id: 'R1' }, message: { reactionMessage: { text: '👍' } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'out');
});

test('describeMessage rotula mídia', () => {
  assert.equal(describeMessage({ audioMessage: {} }), '🎤 Áudio');
  assert.equal(describeMessage({ imageMessage: { caption: 'meu cabelo' } }), '📷 meu cabelo');
  assert.equal(describeMessage({ reactionMessage: {} }), null);
});

test('Sim continua confirmando e também fica no histórico', async () => {
  const { api, rows } = setup();
  const r = await api.handleIncoming(incoming('Sim', 'D1'));
  assert.equal(rows.length, 1);
  assert.equal(r.reason, 'sem_agendamento_aguardando');
});
