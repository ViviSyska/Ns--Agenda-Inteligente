import test from 'node:test';
import assert from 'node:assert/strict';
import { selecionarLaser, janelaDoLaser, dataDoLaser, createReativacao } from '../src/reativacao.js';
import { isOptOut } from '../src/reply-parser.js';

const cli = (id, nome, whatsapp, extra = {}) => ({ id, nome, whatsapp, ...extra });
const ag = (cliente_id, data, status = 'concluido', servicos = ['laser']) => ({ cliente_id, data, status, servicos });

test('acha o último sábado do mês e a semana do laser (segunda até sexta)', () => {
  assert.equal(dataDoLaser('2026-11-10', -1, 6), '2026-11-28');
  assert.equal(dataDoLaser('2026-10-02', -1, 6), '2026-10-31');
  assert.equal(dataDoLaser('2026-12-01', 1, 6), '2026-12-05');
  const j = janelaDoLaser('2026-10-28', -1, 6); // quarta da semana do laser (31/10)
  assert.equal(j.ativa, true); assert.equal(j.laser, '2026-10-31'); assert.equal(j.inicio, '2026-10-26');
  assert.equal(j.diasRestantes, 3); // quarta, quinta, sexta
  assert.equal(janelaDoLaser('2026-10-30', -1, 6).diasRestantes, 1);
  assert.equal(janelaDoLaser('2026-10-20', -1, 6).ativa, false);  // outra semana
  assert.equal(janelaDoLaser('2026-10-31', -1, 6).ativa, false);  // no dia do laser não manda
  assert.equal(janelaDoLaser('2026-11-01', -1, 6).ativa, false);
});

test('pega as últimas que fizeram laser e não voltaram, mais recentes primeiro, até o limite', () => {
  const clientes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => cli(id, id, `1190000000${i}`));
  clientes[4].nao_contatar = true;
  const agendamentos = [
    ag('a', '2026-08-01'), ag('b', '2026-09-01'), ag('c', '2026-07-01'),
    ag('d', '2026-10-20'),                      // voltou há 10 dias: ainda dentro do prazo
    ag('e', '2026-06-01'),                      // pediu para parar
    ag('f', '2026-08-15', 'concluido', ['unha']), // não fez laser
    ag('c', '2026-11-20', 'pendente', ['laser']), // c já tem horário
  ];
  const r = selecionarLaser({ clientes, agendamentos, hoje: '2026-10-28', servicoId: 'laser', minDias: 30, limite: 2 });
  assert.deepEqual(r.map((x) => x.cliente.id), ['b', 'a']);
});

test('não chama quem foi chamada há pouco', () => {
  const clientes = [cli('a', 'Ana', '11988887777'), cli('b', 'Bia', '11977776666')];
  const agendamentos = [ag('a', '2026-08-01'), ag('b', '2026-08-02')];
  const contatos = [{ cliente_id: 'b', enviado_em: '2026-10-20T12:00:00Z' }];
  const r = selecionarLaser({ clientes, agendamentos, contatos, hoje: '2026-10-28', servicoId: 'laser' });
  assert.deepEqual(r.map((x) => x.cliente.id), ['a']);
});

function montar({ cfg, now, contatos = [], n = 20 }) {
  const enviados = []; const marcas = []; const gravados = [];
  const clientes = Array.from({ length: n }, (_, i) => cli('c' + i, 'Cli' + i, `119000000${String(i).padStart(2, '0')}`));
  const agendamentos = clientes.map((c, i) => ag(c.id, `2026-0${1 + (i % 7)}-10`));
  const db = {
    getReativacaoCfg: async () => cfg,
    setReativarUltimo: async (_s, d) => { marcas.push(d); cfg.reativar_ultimo = d; },
    listClientesSalao: async () => clientes,
    listAgendamentosSalao: async () => agendamentos,
    listReativacoes: async () => contatos,
    getSalaoNome: async () => 'Espaço Tela Viva',
    insertReativacao: async (r) => { gravados.push(r); },
  };
  const wa = { getStatus: () => 'open' };
  const sendOne = async (num, t) => { enviados.push({ num, t }); return { ok: true }; };
  const r = createReativacao({ db, wa, sendOne, now: () => now, sleep: async () => {}, log: { info() {}, warn() {} } });
  return { r, enviados, marcas, gravados };
}
const base = { salao_id: 's1', reativar_on: true, reativar_servico: 'laser', reativar_nth: -1, reativar_dow: 6, reativar_dias: 30, reativar_max: 15, reativar_msg: 'Oi {nome}! Laser dia {data} ({dia}) no {salao}' };

test('na segunda da semana do laser manda só uma parte da meta (15 em 5 dias úteis = 3)', async () => {
  const { r, enviados, marcas } = montar({ cfg: { ...base }, now: new Date('2026-10-26T15:00:00Z') }); // segunda 12h
  const out = await r.tick();
  assert.equal(out.enviadas, 3);
  assert.equal(enviados[0].t, 'Oi Cli' .concat(enviados[0].t.slice(6, enviados[0].t.indexOf('!'))) + '! Laser dia 31/10 (sábado) no Espaço Tela Viva');
  assert.deepEqual(marcas, ['2026-10-26']);
  assert.equal((await r.tick()).reason, 'ja_rodou_hoje');
});

test('na sexta completa o que faltou da meta', async () => {
  const contatos = Array.from({ length: 11 }, (_, i) => ({ cliente_id: 'x' + i, enviado_em: '2026-10-27T15:00:00Z' }));
  const { r, enviados } = montar({ cfg: { ...base }, now: new Date('2026-10-30T15:00:00Z'), contatos }); // sexta
  const out = await r.tick();
  assert.equal(out.enviadas, 4); assert.equal(enviados.length, 4);
});

test('fora da semana do laser, no domingo ou desligado não envia', async () => {
  assert.equal((await montar({ cfg: { ...base }, now: new Date('2026-10-14T15:00:00Z') }).r.tick()).reason, 'fora_da_semana_do_laser');
  assert.equal((await montar({ cfg: { ...base }, now: new Date('2026-10-26T23:30:00Z') }).r.tick()).reason, 'fora_do_horario');
  assert.equal((await montar({ cfg: { ...base, reativar_on: false }, now: new Date('2026-10-26T15:00:00Z') }).r.tick()).reason, 'desligado');
  assert.equal((await montar({ cfg: { ...base, reativar_servico: null }, now: new Date('2026-10-26T15:00:00Z') }).r.tick()).reason, 'desligado');
});

test('reconhece pedido para parar', () => {
  for (const t of ['PARAR', 'Sair', 'não quero mais receber', 'Não me envie mensagem']) assert.ok(isOptOut(t), t);
  for (const t of ['sim', 'não vou poder ir', 'quero marcar']) assert.ok(!isOptOut(t), t);
});
