import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const silent = { info() {}, warn() {}, error() {} };
const baseCfg = {
  apiKey: 'segredo', corsOrigin: '*', delayMinMs: 0, delayMaxMs: 0, maxBulk: 5, waitOpenMs: 0,
  autoReply: true,
  replyConfirmou: 'Ok {nome}, {data} {hora} confirmado',
  replyRecusou: 'Tudo bem {nome}, cancelado {data} {hora}',
};

function setup({ state = 'open', clientes = [], aguardando = [], cfg = {} } = {}) {
  const sent = [];
  const updates = [];
  const sock = {
    onWhatsApp: async (n) => [{ jid: `${n}@s.whatsapp.net`, exists: !String(n).endsWith('0000') }],
    sendMessage: async (jid, msg) => { sent.push({ jid, text: msg.text }); return { key: { id: 'id' + sent.length } }; },
    signalRepository: { lidMapping: { getPNForLID: async () => '5511988887777@s.whatsapp.net' } },
  };
  const wa = { status: state, getStatus() { return this.status; }, getSock: () => sock, getQR: () => null, getUser: () => null, logout: async () => {} };
  const db = {
    listClientes: async () => clientes,
    listAguardando: async (ids) => aguardando.filter((a) => ids.includes(a.cliente_id)),
    updateAgendamento: async (id, f) => { updates.push({ id, ...f }); },
  };
  const api = createApp({ cfg: { ...baseCfg, ...cfg }, db, wa, log: silent, sleep: async () => {} });
  return { api, wa, sent, updates };
}

async function serve(app) {
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => server.close() };
}
const H = { 'content-type': 'application/json', apikey: 'segredo' };

test('health é público; rotas exigem apikey', async () => {
  const { api } = setup();
  const s = await serve(api.app);
  try {
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    assert.equal((await fetch(`${s.base}/instance/connectionState/salao`)).status, 401);
    assert.equal((await fetch(`${s.base}/instance/connectionState/salao`, { headers: { apikey: 'errada' } })).status, 401);
    const ok = await fetch(`${s.base}/instance/connectionState/salao`, { headers: { apikey: 'segredo' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).instance.state, 'open');
    const pre = await fetch(`${s.base}/message/sendBulk/salao`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /apikey/);
  } finally { s.close(); }
});

test('sendBulk: 503 quando desconectado', async () => {
  const { api } = setup({ state: 'close' });
  const s = await serve(api.app);
  try {
    const r = await fetch(`${s.base}/message/sendBulk/salao`, { method: 'POST', headers: H, body: JSON.stringify({ messages: [{ number: '11999991111', text: 'oi' }] }) });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'whatsapp_desconectado');
  } finally { s.close(); }
});

test('sendBulk: envia tudo, marca aguardando e reporta falhas', async () => {
  const { api, sent, updates } = setup();
  const s = await serve(api.app);
  try {
    const body = { messages: [
      { number: '(11) 99999-1111', text: 'Oi Ana', agId: 'ag1', name: 'Ana' },
      { number: '11999990000', text: 'Oi Sem Zap', agId: 'ag2', name: 'SemZap' }, // onWhatsApp → não existe
      { number: '123', text: 'Oi inválida', agId: 'ag3', name: 'Inv' },
      { number: '11 98888-2222', text: 'Oi Bia', agId: 'ag4', name: 'Bia' },
    ] };
    const r = await fetch(`${s.base}/message/sendBulk/salao`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    assert.equal(r.status, 202);
    const j = await r.json();
    assert.equal(j.queued, 3);
    assert.equal(j.rejected.length, 1);
    assert.ok(j.estimateMin >= 1);
    for (let i = 0; i < 50; i++) {
      const st = await (await fetch(`${s.base}/message/jobs/salao/${j.jobId}`, { headers: H })).json();
      if (st.status === 'concluido') {
        assert.equal(st.sent, 2); assert.equal(st.failed, 2); assert.equal(st.total, 4);
        assert.deepEqual(st.items.map((x) => x.status), ['enviado', 'falhou', 'falhou', 'enviado']);
        assert.equal(st.items[1].error, 'numero_sem_whatsapp');
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(i < 49, 'job não concluiu');
    }
    assert.deepEqual(sent.map((x) => x.jid), ['5511999991111@s.whatsapp.net', '5511988882222@s.whatsapp.net']);
    assert.deepEqual(updates.map((u) => [u.id, u.wa_status]), [['ag1', 'aguardando'], ['ag4', 'aguardando']]);
  } finally { s.close(); }
});

test('sendBulk: limite de lote e validação', async () => {
  const { api } = setup();
  const s = await serve(api.app);
  try {
    const many = Array.from({ length: 6 }, () => ({ number: '11999991111', text: 'x' }));
    assert.equal((await fetch(`${s.base}/message/sendBulk/salao`, { method: 'POST', headers: H, body: JSON.stringify({ messages: many }) })).status, 400);
    assert.equal((await fetch(`${s.base}/message/sendBulk/salao`, { method: 'POST', headers: H, body: JSON.stringify({}) })).status, 400);
    assert.equal((await fetch(`${s.base}/message/jobs/salao/nao-existe`, { headers: H })).status, 404);
  } finally { s.close(); }
});

test('sendText (compatível com a Evolution API)', async () => {
  const { api, sent } = setup();
  const s = await serve(api.app);
  try {
    const r = await fetch(`${s.base}/message/sendText/salao`, { method: 'POST', headers: H, body: JSON.stringify({ number: '5511999991111', text: 'Relatório' }) });
    assert.equal(r.status, 201);
    assert.equal(sent[0].text, 'Relatório');
    const bad = await fetch(`${s.base}/message/sendText/salao`, { method: 'POST', headers: H, body: JSON.stringify({ number: '11999990000', text: 'x' }) });
    assert.equal(bad.status, 400);
  } finally { s.close(); }
});

const clientes = [
  { id: 'c1', nome: 'Ana Paula Souza', whatsapp: '(11) 99999-1111' },
  { id: 'c2', nome: 'Bia', whatsapp: '1188887777' }, // sem o nono dígito
];
const msg = (jid, text, extra = {}) => ({ key: { remoteJid: jid, fromMe: false, ...extra }, message: { conversation: text } });

test('resposta "Sim" confirma o horário mais próximo e responde', async () => {
  const { api, sent, updates } = setup({
    clientes,
    aguardando: [
      { id: 'a2', cliente_id: 'c1', data: '2026-11-07', hora: '15:00', status: 'pendente', wa_status: 'aguardando' },
      { id: 'a1', cliente_id: 'c1', data: '2026-11-03', hora: '14:00', status: 'pendente', wa_status: 'aguardando' },
      { id: 'a3', cliente_id: 'c1', data: '2026-11-03', hora: '16:30', status: 'confirmado', wa_status: 'aguardando' },
    ].sort((x, y) => x.data.localeCompare(y.data) || x.hora.localeCompare(y.hora)),
  });
  const r = await api.handleIncoming(msg('5511999991111@s.whatsapp.net', 'Sim, confirmo!'));
  assert.equal(r.handled, true);
  assert.equal(r.verdict, 'confirmou');
  assert.deepEqual(r.updated.sort(), ['a1', 'a3']);
  assert.deepEqual(updates.find((u) => u.id === 'a1'), { id: 'a1', wa_status: 'confirmou', status: 'confirmado' });
  assert.deepEqual(updates.find((u) => u.id === 'a3'), { id: 'a3', wa_status: 'confirmou' }); // já estava confirmado
  assert.equal(updates.length, 2);
  assert.equal(sent[0].jid, '5511999991111@s.whatsapp.net');
  assert.equal(sent[0].text, 'Ok Ana, 03/11 14:00 e 16:30 confirmado');
});

test('resposta "Não" cancela', async () => {
  const { api, sent, updates } = setup({
    clientes,
    aguardando: [{ id: 'a1', cliente_id: 'c1', data: '2026-11-03', hora: '14:00', status: 'confirmado', wa_status: 'aguardando' }],
  });
  const r = await api.handleIncoming(msg('5511999991111@s.whatsapp.net', 'Não vou conseguir'));
  assert.equal(r.verdict, 'recusou');
  assert.deepEqual(updates, [{ id: 'a1', wa_status: 'recusou' }]);
  assert.match(sent[0].text, /cancelado 03\/11 14:00/);
});

test('casa número com/sem nono dígito e resolve LID via remoteJidAlt e via mapeamento', async () => {
  const ags = [{ id: 'b1', cliente_id: 'c2', data: '2026-11-03', hora: '10:00', status: 'pendente', wa_status: 'aguardando' }];
  let t = setup({ clientes, aguardando: ags });
  assert.equal((await t.api.handleIncoming(msg('5511988887777@s.whatsapp.net', 'sim'))).handled, true);

  t = setup({ clientes, aguardando: ags });
  assert.equal((await t.api.handleIncoming(msg('99887766@lid', 'sim', { remoteJidAlt: '5511988887777@s.whatsapp.net' }))).handled, true);
  assert.equal(t.sent[0].jid, '99887766@lid'); // responde no mesmo chat (LID)

  t = setup({ clientes, aguardando: ags });
  assert.equal((await t.api.handleIncoming(msg('99887766@lid', 'sim'))).handled, true); // via lidMapping
});

test('ignora: mensagem própria, grupo, conversa, sem pendência, cliente desconhecida', async () => {
  const ags = [{ id: 'a1', cliente_id: 'c1', data: '2026-11-03', hora: '14:00', status: 'pendente', wa_status: 'aguardando' }];
  const { api, sent, updates } = setup({ clientes, aguardando: ags });
  assert.equal((await api.handleIncoming({ key: { remoteJid: '5511999991111@s.whatsapp.net', fromMe: true }, message: { conversation: 'sim' } })).reason, 'ignorada');
  assert.equal((await api.handleIncoming(msg('123@g.us', 'sim'))).reason, 'grupo_ou_lista');
  assert.equal((await api.handleIncoming(msg('5511999991111@s.whatsapp.net', 'Qual o endereço?'))).reason, 'nao_e_resposta');
  assert.equal((await api.handleIncoming(msg('5521977776666@s.whatsapp.net', 'sim'))).reason, 'cliente_nao_encontrada');
  assert.equal((await api.handleIncoming({ key: { remoteJid: '5511999991111@s.whatsapp.net' } })).reason, 'ignorada');
  const semPend = setup({ clientes, aguardando: [] });
  assert.equal((await semPend.api.handleIncoming(msg('5511999991111@s.whatsapp.net', 'sim'))).reason, 'sem_agendamento_aguardando');
  assert.equal(updates.length + sent.length, 0);
});

test('AUTO_REPLY=false não responde, mas registra', async () => {
  const { api, sent, updates } = setup({
    clientes, cfg: { autoReply: false },
    aguardando: [{ id: 'a1', cliente_id: 'c1', data: '2026-11-03', hora: '14:00', status: 'pendente', wa_status: 'aguardando' }],
  });
  assert.equal((await api.handleIncoming(msg('5511999991111@s.whatsapp.net', 'sim'))).handled, true);
  assert.equal(updates.length, 1);
  assert.equal(sent.length, 0);
});

// ---------- só a primeira mensagem depois do lembrete vale ----------
function setupResposta({ enviadoEm, historico }) {
  const sent = []; const updates = [];
  const sock = { sendMessage: async (jid, msg) => { sent.push({ jid, text: msg.text }); return { key: { id: 'r' } }; }, signalRepository: { lidMapping: { getPNForLID: async () => null } } };
  const wa = { getStatus: () => 'open', getSock: () => sock, getQR: () => null, getUser: () => null, logout: async () => {} };
  const db = {
    listClientes: async () => [{ id: 'c1', nome: 'Ana Souza', whatsapp: '11988887777' }],
    listAguardando: async () => [{ id: 'a1', cliente_id: 'c1', data: '2026-10-31', hora: '14:00', status: 'pendente', wa_status: 'aguardando', wa_enviado_em: enviadoEm }],
    updateAgendamento: async (id, f) => { updates.push({ id, ...f }); },
    listChatMessages: async () => historico,
    insertMessage: async () => {},
  };
  const api = createApp({ cfg: { ...baseCfg }, db, wa, log: silent, sleep: async () => {} });
  return { api, sent, updates };
}
const mensagem = (texto, ts) => ({ key: { remoteJid: '5511988887777@s.whatsapp.net', id: 'M1', fromMe: false }, message: { conversation: texto }, messageTimestamp: Math.floor(Date.parse(ts) / 1000) });

test('primeira resposta depois do lembrete: registra o NÃO', async () => {
  const { api, updates } = setupResposta({ enviadoEm: '2026-10-30T12:00:00Z', historico: [{ direction: 'out', ts: '2026-10-30T12:00:00Z', wa_id: 'L1' }, { direction: 'in', ts: '2026-10-30T13:00:00Z', wa_id: 'M1' }] });
  const r = await api.handleIncoming(mensagem('não', '2026-10-30T13:00:00Z'));
  assert.equal(r.handled, true);
  assert.deepEqual(updates, [{ id: 'a1', wa_status: 'recusou' }]);
});

test('"não" numa conversa que já teve resposta depois do lembrete NÃO cancela nada', async () => {
  const { api, updates, sent } = setupResposta({ enviadoEm: '2026-10-30T12:00:00Z', historico: [
    { direction: 'out', ts: '2026-10-30T12:00:00Z', wa_id: 'L1' },
    { direction: 'in', ts: '2026-10-30T12:30:00Z', wa_id: 'M0' },   // ela já respondeu antes (qualquer mensagem)
    { direction: 'in', ts: '2026-10-30T18:00:00Z', wa_id: 'M1' },
  ] });
  const r = await api.handleIncoming(mensagem('não', '2026-10-30T18:00:00Z'));
  assert.equal(r.handled, false); assert.equal(r.reason, 'nao_e_resposta_ao_lembrete');
  assert.deepEqual(updates, []); assert.deepEqual(sent, []);
});

test('"não" dois dias depois do lembrete não vale', async () => {
  const { api, updates } = setupResposta({ enviadoEm: '2026-10-27T12:00:00Z', historico: [{ direction: 'out', ts: '2026-10-27T12:00:00Z', wa_id: 'L1' }, { direction: 'in', ts: '2026-10-30T13:00:00Z', wa_id: 'M1' }] });
  const r = await api.handleIncoming(mensagem('não', '2026-10-30T13:00:00Z'));
  assert.equal(r.handled, false); assert.deepEqual(updates, []);
});

test('lembrete antigo sem horário: só vale se a mensagem anterior foi nossa', async () => {
  const { api, updates } = setupResposta({ enviadoEm: null, historico: [{ direction: 'in', ts: '2026-10-30T12:00:00Z', wa_id: 'M0' }, { direction: 'in', ts: '2026-10-30T13:00:00Z', wa_id: 'M1' }] });
  const r = await api.handleIncoming(mensagem('não', '2026-10-30T13:00:00Z'));
  assert.equal(r.handled, false); assert.deepEqual(updates, []);
});
