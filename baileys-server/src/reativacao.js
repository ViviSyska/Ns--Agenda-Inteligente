// Semana do laser: chama de volta quem fez laser e não voltou. Poucas mensagens por dia,
// espalhadas pela semana, só na semana em que o laser acontece (ex.: último sábado do mês).
import { phoneKey } from './phone.js';

const dayMs = 86400000;
const diffDias = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / dayMs);
const isoUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDias = (iso, n) => isoUTC(Date.parse(iso + 'T12:00:00Z') + n * dayMs);
const dowDe = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

/** Data do dia do laser no mês de `hoje` (nth: 1..4 ou -1 = último; dow: 0 domingo … 6 sábado). */
export function dataDoLaser(hoje, nth = -1, dow = 6) {
  const y = Number(hoje.slice(0, 4)); const m = Number(hoje.slice(5, 7)) - 1;
  if (nth === -1) {
    const ult = new Date(Date.UTC(y, m + 1, 0, 12));
    const back = (ult.getUTCDay() - dow + 7) % 7;
    return isoUTC(Date.UTC(y, m, ult.getUTCDate() - back, 12));
  }
  const prim = new Date(Date.UTC(y, m, 1, 12));
  const off = (dow - prim.getUTCDay() + 7) % 7;
  const dia = 1 + off + (nth - 1) * 7;
  const d = new Date(Date.UTC(y, m, dia, 12));
  return d.getUTCMonth() === m ? isoUTC(d.getTime()) : null;
}

/**
 * Janela de envio de um evento mensal (ex.: laser no último sábado).
 * `diasAntes` null = semana do evento (da segunda até o dia antes); número = esse tanto de dias antes.
 * Nunca manda no domingo nem no dia do evento. `pulados` = meses (1..12) em que o evento não acontece.
 * Olha o mês de hoje e o seguinte (a janela pode começar no fim do mês anterior).
 * Devolve { ativa, laser, inicio, diasRestantes } (dias úteis restantes, contando hoje).
 */
export function janelaDoLaser(hoje, nth, dow, diasAntes = null, pulados = []) {
  let ultimo = null;
  const y = Number(hoje.slice(0, 4)); const m = Number(hoje.slice(5, 7));
  for (const [yy, mm] of [[y, m], m === 12 ? [y + 1, 1] : [y, m + 1]]) {
    if ((pulados || []).includes(mm)) continue;
    const ref = `${yy}-${String(mm).padStart(2, '0')}-15`;
    const laser = dataDoLaser(ref, nth, dow);
    if (!laser) continue;
    const dias = diasAntes == null || diasAntes === '' ? null : Math.max(1, Math.min(14, Number(diasAntes)));
    const seg = dias == null ? addDias(laser, -((dowDe(laser) + 6) % 7)) : addDias(laser, -dias);
    const fim = addDias(laser, -1);
    ultimo = ultimo || { ativa: false, laser, inicio: seg };
    if (hoje < seg || hoje > fim || dowDe(hoje) === 0) continue;
    let n = 0;
    for (let d = hoje; d <= fim; d = addDias(d, 1)) if (dowDe(d) !== 0) n++;
    return { ativa: true, laser, inicio: seg, diasRestantes: Math.max(1, n) };
  }
  return { ativa: false, laser: ultimo?.laser || null, inicio: ultimo?.inicio };
}
export const janelaDoEvento = janelaDoLaser;

/**
 * Quem chamar hoje: fez o serviço (ou qualquer atendimento, se não houver serviço), não tem nada marcado, a última vez foi há mais de `minDias`,
 * e não foi chamada há pouco. As mais recentes primeiro. Devolve no máximo `limite`.
 */
export const selecionarSumidas = (...a) => selecionarLaser(...a);
export function selecionarLaser({ clientes, agendamentos, contatos = [], hoje, servicoId = null, minDias = 30, cooldownDias = 25, limite = 15 }) {
  const porCli = new Map();
  for (const a of agendamentos) {
    const o = porCli.get(a.cliente_id) || { ultima: null, visitas: 0, futura: false };
    const d = String(a.data || '').substring(0, 10);
    const fezServico = !servicoId || (a.servicos || []).includes(servicoId); // sem serviço = qualquer atendimento
    if (a.status === 'concluido' && fezServico) {
      o.visitas++;
      if (!o.ultima || d > o.ultima) o.ultima = d;
    }
    if ((a.status === 'pendente' || a.status === 'confirmado') && d >= hoje) o.futura = true; // qualquer horário marcado
    porCli.set(a.cliente_id, o);
  }
  const ultimoContato = new Map();
  for (const c of contatos) {
    const d = String(c.enviado_em || '').substring(0, 10);
    if (!ultimoContato.get(c.cliente_id) || d > ultimoContato.get(c.cliente_id)) ultimoContato.set(c.cliente_id, d);
  }
  const vistos = new Set();
  const out = [];
  for (const c of clientes) {
    if (c.nao_contatar || !c.whatsapp) continue;
    const k = phoneKey(c.whatsapp);
    if (!k || vistos.has(k)) continue;
    const o = porCli.get(c.id);
    if (!o || !o.ultima || o.futura) continue;
    const sumiu = diffDias(o.ultima, hoje);
    if (sumiu <= minDias) continue;
    const uc = ultimoContato.get(c.id);
    if (uc && diffDias(uc, hoje) < cooldownDias) continue;
    vistos.add(k);
    out.push({ cliente: c, sumiuDias: sumiu, ultima: o.ultima, visitas: o.visitas });
  }
  out.sort((a, b) => (a.ultima < b.ultima ? 1 : a.ultima > b.ultima ? -1 : b.visitas - a.visitas));
  return out.slice(0, limite);
}

const brParts = (now) => {
  const s = now.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // 2026-10-30 18:57:00
  return { data: s.slice(0, 10), hora: Number(s.slice(11, 13)) };
};
const fmtBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export const TEXTO_PADRAO =
  'Oi {nome}! Tudo bem? 💛 Dia {data} ({dia}) é o dia do {servico} aqui no {salao}. Quer garantir o seu horário? É só me responder por aqui!';
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// Limites que protegem o número do WhatsApp (mensagem em massa para quem não conversa é o que bloqueia):
export const LIMITE_POR_CICLO = 15; // no máximo 15 clientes por automação a cada ciclo (semana)
export const LIMITE_POR_DIA = 8;    // no máximo 8 mensagens automáticas por dia, somando todas as automações do salão

export function createAutomacoes({ db, wa, sendOne, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), horaIni = 10, horaFim = 17, pausaMinMs = 30000, pausaMaxMs = 90000, salaoId = null, limiteDia = LIMITE_POR_DIA }) {
  let rodando = false;

  async function rodarUma(au, t, ctx) {
    if (au.publico && au.publico !== 'sumiu') return { ran: false, reason: 'tipo_nao_suportado' };
    if (au.quando && au.quando !== 'calendario') return { ran: false, reason: 'tipo_nao_suportado' };
    const jan = janelaDoLaser(t.data, Number(au.nth ?? -1), Number(au.dow ?? 6), au.dias_antes, au.meses_pulados || []);
    if (!jan.ativa) return { ran: false, reason: 'fora_da_janela' };
    if (String(au.ultimo_envio || '') === t.data) return { ran: false, reason: 'ja_rodou_hoje' };
    await db.setAutomacaoUltimo(au.id, t.data); // marca antes: nunca roda 2x no mesmo dia
    const meta = Math.min(LIMITE_POR_CICLO, Math.max(1, Number(au.max_ciclo) || LIMITE_POR_CICLO));
    const doCiclo = new Set(ctx.contatos.filter((c) => c.automacao_id === au.id && String(c.enviado_em).substring(0, 10) >= jan.inicio).map((c) => c.cliente_id)).size;
    const faltam = Math.max(0, meta - doCiclo);
    const capDia = Math.max(0, limiteDia - ctx.enviadasHoje);
    const hoje = Math.min(Math.ceil(faltam / jan.diasRestantes), capDia); // espalha pelo ciclo e respeita o teto do dia
    if (!hoje) return { ran: true, enviadas: 0, candidatas: 0, reason: capDia ? 'meta_do_ciclo_cumprida' : 'limite_do_dia' };
    const lista = selecionarLaser({
      clientes: ctx.clientes, agendamentos: ctx.agendamentos, contatos: ctx.contatos, hoje: t.data, servicoId: au.servico_id || null,
      minDias: Number(au.sumiu_dias) || 30, cooldownDias: Number(au.cooldown_dias) || 25, limite: hoje,
    });
    const tpl = (au.mensagem || '').trim() || TEXTO_PADRAO;
    let enviadas = 0;
    for (const item of lista) {
      const texto = fill(tpl, {
        nome: String(item.cliente.nome || '').split(' ')[0], salao: ctx.salao || 'salão', data: fmtBR(jan.laser), dia: DIAS[dowDe(jan.laser)],
        servico: ctx.servicos.get(au.servico_id) || 'atendimento',
      });
      const r = await sendOne(item.cliente.whatsapp, texto);
      if (r.ok) {
        enviadas++; ctx.enviadasHoje++;
        const row = { salao_id: au.salao_id, cliente_id: item.cliente.id, automacao_id: au.id, enviado_em: now().toISOString() };
        await db.insertReativacao(row);
        ctx.contatos.unshift(row);
      } else if (r.error === 'whatsapp_desconectado') break;
      else log.warn?.({ cliente: item.cliente.id, erro: r.error }, 'automação: não enviou');
      await sleep(pausaMinMs + Math.random() * Math.max(0, pausaMaxMs - pausaMinMs));
    }
    log.info?.({ automacao: au.nome, enviadas, candidatas: lista.length, evento: jan.laser }, 'automação concluída');
    return { ran: true, enviadas, candidatas: lista.length };
  }

  async function tick() {
    if (rodando) return { ran: false, reason: 'ocupado' };
    const lista = await db.listAutomacoes(salaoId);
    if (!lista.length) return { ran: false, reason: 'desligado' };
    const t = brParts(now());
    if (t.hora < horaIni || t.hora >= horaFim) return { ran: false, reason: 'fora_do_horario' };
    if (wa.getStatus() !== 'open') return { ran: false, reason: 'whatsapp_desconectado' };
    rodando = true;
    try {
      const porSalao = new Map();
      for (const a of lista) porSalao.set(a.salao_id, [...(porSalao.get(a.salao_id) || []), a]);
      const out = [];
      for (const [sid, ains] of porSalao) {
        // só carrega os dados do salão se alguma automação dele cai na janela de hoje
        const aptas = ains.filter((a) => String(a.ultimo_envio || '') !== t.data && janelaDoLaser(t.data, Number(a.nth ?? -1), Number(a.dow ?? 6), a.dias_antes, a.meses_pulados || []).ativa);
        if (!aptas.length) { out.push(...ains.map((a) => ({ id: a.id, reason: String(a.ultimo_envio || '') === t.data ? 'ja_rodou_hoje' : 'fora_da_janela' }))); continue; }
        const [clientes, agendamentos, contatos, salao, servicos] = await Promise.all([
          db.listClientesSalao(sid), db.listAgendamentosSalao(sid), db.listReativacoes(sid), db.getSalaoNome(sid), db.listServicosNomes(sid),
        ]);
        const enviadasHoje = contatos.filter((c) => brParts(new Date(c.enviado_em)).data === t.data).length;
        const ctx = { clientes, agendamentos, contatos, salao, servicos, enviadasHoje };
        for (const a of ains) out.push({ id: a.id, ...(await rodarUma(a, t, ctx)) });
      }
      const ran = out.some((o) => o.ran);
      return { ran, enviadas: out.reduce((n, o) => n + (o.enviadas || 0), 0), reason: ran ? undefined : out[0]?.reason, detalhe: out };
    } finally {
      rodando = false;
    }
  }
  return { tick };
}
export const createReativacao = createAutomacoes;
