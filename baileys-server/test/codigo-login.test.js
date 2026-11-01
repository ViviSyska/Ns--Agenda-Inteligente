import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sid = 'sess-1') => `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', session_id: sid })}.sig`;
const silent = { info() {}, warn() {}, error() {} };

function montar({ sec = { whatsapp: '5511988887777', exigir_codigo: true }, user = { id: 'u1' }, status = 'open', recentes = [], sendOk = true } = {}) {
  const codigos = []; const enviados = []; const invalidados = [];
  const sock = { onWhatsApp: async (n) => [{ jid: `${n}@s.whatsapp.net`, exists: sendOk }], sendMessage: async (jid, m) => { enviados.push({ jid, text: m.text }); return { key: { id: 'x' } }; } };
  const wa = { getStatus: () => status, getSock: () => sock };
  const db = {
    getUsuarioDoToken: async (t) => (t.startsWith('ruim') ? null : user),
    getSeguranca: async () => sec,
    codigosRecentes: async () => recentes,
    criarCodigo: async (r) => { codigos.push(r); return 'cod1'; },
    invalidarCodigo: async (id) => { invalidados.push(id); },
    insertMessage: async () => { throw new Error('não deveria gravar o código no histórico'); },
  };
  const api = createApp({ cfg: { apiKey: 'k', corsOrigin: '*', delayMinMs: 0, delayMaxMs: 0, maxBulk: 5, waitOpenMs: 0 }, db, wa, log: silent, sleep: async () => {} });
  return { api, codigos, enviados, invalidados };
}
async function chamar(api, tok) {
  const server = await new Promise((r) => { const s = api.app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/codigo`, { method: 'POST', headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test('envia um código de 6 dígitos pelo WhatsApp e guarda só o hash (sem gravar no histórico)', async () => {
  const m = montar();
  const r = await chamar(m.api, token());
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.destino, '…7777');
  const cod = m.enviados[0].text.match(/\*(\d{6})\*/)[1];
  assert.equal(m.codigos[0].hash, createHash('sha256').update(`${cod}:u1:sess-1`).digest('hex'));
  assert.ok(!JSON.stringify(r.body).includes(cod));       // o código não volta para o app
  assert.ok(!JSON.stringify(m.codigos[0]).includes(cod)); // e não fica guardado em claro
  assert.match(m.enviados[0].jid, /^5511988887777@/);
});
test('sem token ou com token inválido: 401', async () => {
  const m = montar();
  assert.equal((await chamar(m.api, null)).status, 401);
  assert.equal((await chamar(m.api, 'ruim.x.y')).status, 401);
  assert.equal(m.enviados.length, 0);
});
test('sem WhatsApp cadastrado, sem session_id, desconectado', async () => {
  assert.equal((await chamar(montar({ sec: { whatsapp: '' } }).api, token())).body.error, 'sem_whatsapp');
  assert.equal((await chamar(montar().api, `${b64({})}.${b64({ sub: 'u1' })}.s`)).body.error, 'sem_session_id');
  assert.equal((await chamar(montar({ status: 'close' }).api, token())).status, 503);
});
test('limita: 1 a cada 45s e 6 por hora', async () => {
  const agora = new Date().toISOString();
  const a = await chamar(montar({ recentes: [{ criado_em: agora }] }).api, token());
  assert.equal(a.status, 429); assert.equal(a.body.error, 'aguarde');
  const velhos = Array.from({ length: 6 }, (_, i) => ({ criado_em: new Date(Date.now() - (60 + i) * 60000 / 2).toISOString() }));
  assert.equal((await chamar(montar({ recentes: velhos }).api, token())).body.error, 'limite_por_hora');
});
test('se o WhatsApp não entrega, invalida o código e avisa', async () => {
  const m = montar({ sendOk: false });
  const r = await chamar(m.api, token());
  assert.equal(r.status, 502); assert.deepEqual(m.invalidados, ['cod1']);
});
