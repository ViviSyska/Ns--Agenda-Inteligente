import test from 'node:test';
import assert from 'node:assert/strict';
import { selecionar, createReativacao } from '../src/reativacao.js';
import { isOptOut } from '../src/reply-parser.js';

const cli = (id, nome, whatsapp, extra = {}) => ({ id, nome, whatsapp, ...extra });
const ag = (cliente_id, data, status = 'concluido') => ({ cliente_id, data, status });

test('seleciona só quem passou do prazo, sem futura, sem contato recente, sem pedido de parar', () => {
  const clientes = [
    cli('a', 'Ana', '11988887777'), cli('b', 'Bia', '11977776666'), cli('c', 'Cris', '11966665555'),
    cli('d', 'Dani', '11955554444', { nao_contatar: true }), cli('e', 'Eva', '11944443333'), cli('f', 'Fabi', '11933332222'),
  ];
  const agendamentos = [
    ag('a', '2026-07-01'), ag('a', '2026-08-01'),            // última 2026-08-01 → 90 dias: sumida
    ag('b', '2026-10-10'),                                   // recente: não
    ag('c', '2026-06-01'), ag('c', '2026-11-20', 'pendente'),// tem horário futuro: não
    ag('d', '2026-05-01'),                                   // pediu para parar: não
    ag('e', '2026-05-01'),                                   // sumida mas já chamada há 20 dias: não
    // f nunca veio: não
  ];
  const contatos = [{ cliente_id: 'e', enviado_em: '2026-10-10T12:00:00Z' }];
  const r = selecionar({ clientes, agendamentos, contatos, hoje: '2026-10-30', dias: 60 });
  assert.deepEqual(r.map((x) => x.cliente.id), ['a']);
  assert.equal(r[0].sumiuDias, 90);
});

test('respeita o limite por dia e ordena por quem mais vinha', () => {
  const clientes = ['a', 'b', 'c'].map((id, i) => cli(id, id, `1190000000${i}`));
  const agendamentos = [ag('a', '2026-01-01'), ag('b', '2026-01-01'), ag('b', '2026-02-01'), ag('c', '2026-01-01')];
  const r = selecionar({ clientes, agendamentos, hoje: '2026-10-30', dias: 60, max: 2 });
  assert.equal(r.length, 2);
  assert.equal(r[0].cliente.id, 'b');
});

test('mesmo telefone em dois cadastros recebe uma mensagem só', () => {
  const clientes = [cli('a', 'Ana', '(11) 98888-7777'), cli('b', 'Ana 2', '11988887777')];
  const agendamentos = [ag('a', '2026-01-01'), ag('b', '2026-01-01')];
  assert.equal(selecionar({ clientes, agendamentos, hoje: '2026-10-30', dias: 60 }).length, 1);
});

function montar({ cfg, now }) {
  const enviados = []; const marcas = []; const gravados = [];
  const db = {
    getReativacaoCfg: async () => cfg,
    setReativarUltimo: async (_s, d) => { marcas.push(d); cfg.reativar_ultimo = d; },
    listClientesSalao: async () => [cli('a', 'Ana Souza', '11988887777')],
    listAgendamentosSalao: async () => [ag('a', '2026-01-01')],
    listReativacoes: async () => [],
    getSalaoNome: async () => 'Espaço Tela Viva',
    insertReativacao: async (r) => { gravados.push(r); },
  };
  const wa = { getStatus: () => 'open' };
  const sendOne = async (n, t) => { enviados.push({ n, t }); return { ok: true }; };
  const r = createReativacao({ db, wa, sendOne, now: () => now, sleep: async () => {}, log: { info() {}, warn() {} } });
  return { r, enviados, marcas, gravados };
}

test('manda a mensagem com o nome e o salão e marca o dia', async () => {
  const cfg = { salao_id: 's1', reativar_on: true, reativar_dias: 60, reativar_max: 8, reativar_msg: 'Oi {nome}, saudade do {salao}!' };
  const { r, enviados, marcas, gravados } = montar({ cfg, now: new Date('2026-10-30T15:00:00Z') }); // 12h em Brasília
  const out = await r.tick();
  assert.equal(out.enviadas, 1);
  assert.equal(enviados[0].t, 'Oi Ana, saudade do Espaço Tela Viva!');
  assert.deepEqual(marcas, ['2026-10-30']);
  assert.equal(gravados[0].cliente_id, 'a');
  assert.equal((await r.tick()).reason, 'ja_rodou_hoje');
});

test('não roda desligado, domingo ou fora do horário', async () => {
  const on = { salao_id: 's1', reativar_on: true };
  assert.equal((await montar({ cfg: { ...on, reativar_on: false }, now: new Date('2026-10-30T15:00:00Z') }).r.tick()).reason, 'desligado');
  assert.equal((await montar({ cfg: { ...on }, now: new Date('2026-11-01T15:00:00Z') }).r.tick()).reason, 'fora_do_horario'); // domingo
  assert.equal((await montar({ cfg: { ...on }, now: new Date('2026-10-30T23:30:00Z') }).r.tick()).reason, 'fora_do_horario'); // 20h30
});

test('reconhece pedido para parar', () => {
  for (const t of ['PARAR', 'Sair', 'não quero mais receber', 'Não me envie mensagem']) assert.ok(isOptOut(t), t);
  for (const t of ['sim', 'não vou poder ir', 'quero marcar']) assert.ok(!isOptOut(t), t);
});
