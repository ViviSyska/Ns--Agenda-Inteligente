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
 * A semana do laser vai da segunda-feira até o dia ANTES do laser.
 * Devolve { ativa, laser, inicio, diasRestantes } (dias úteis restantes, contando hoje).
 */
export function janelaDoLaser(hoje, nth, dow) {
  const laser = dataDoLaser(hoje, nth, dow);
  if (!laser) return { ativa: false, laser: null };
  const seg = addDias(laser, -((dowDe(laser) + 6) % 7)); // segunda da semana do laser
  const fim = addDias(laser, -1);
  if (hoje < seg || hoje > fim || dowDe(hoje) === 0) return { ativa: false, laser, inicio: seg };
  let n = 0;
  for (let d = hoje; d <= fim; d = addDias(d, 1)) if (dowDe(d) !== 0) n++;
  return { ativa: true, laser, inicio: seg, diasRestantes: Math.max(1, n) };
}

/**
 * Quem chamar hoje: fez o serviço (laser), não tem nada marcado, a última vez foi há mais de `minDias`,
 * e não foi chamada há pouco. As mais recentes primeiro. Devolve no máximo `limite`.
 */
export function selecionarLaser({ clientes, agendamentos, contatos = [], hoje, servicoId, minDias = 30, cooldownDias = 25, limite = 15 }) {
  const porCli = new Map();
  for (const a of agendamentos) {
    const o = porCli.get(a.cliente_id) || { ultima: null, visitas: 0, futura: false };
    const d = String(a.data || '').substring(0, 10);
    const fezServico = (a.servicos || []).includes(servicoId);
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
  'Oi {nome}! Tudo bem? 💛 Dia {data} ({dia}) é o dia do laser aqui no {salao}. Quer garantir o seu horário? É só me responder por aqui!';
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export function createReativacao({ db, wa, sendOne, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), horaIni = 10, horaFim = 17, pausaMinMs = 30000, pausaMaxMs = 90000, salaoId = null }) {
  let rodando = false;

  async function tick() {
    if (rodando) return { ran: false, reason: 'ocupado' };
    const cfg = await db.getReativacaoCfg(salaoId);
    if (!cfg || !cfg.reativar_on || !cfg.reativar_servico) return { ran: false, reason: 'desligado' };
    const t = brParts(now());
    if (t.hora < horaIni || t.hora >= horaFim) return { ran: false, reason: 'fora_do_horario' };
    const nth = cfg.reativar_nth == null ? -1 : Number(cfg.reativar_nth);
    const dow = cfg.reativar_dow == null ? 6 : Number(cfg.reativar_dow);
    const jan = janelaDoLaser(t.data, nth, dow);
    if (!jan.ativa) return { ran: false, reason: 'fora_da_semana_do_laser' };
    if (String(cfg.reativar_ultimo || '') === t.data) return { ran: false, reason: 'ja_rodou_hoje' };
    if (wa.getStatus() !== 'open') return { ran: false, reason: 'whatsapp_desconectado' };
    rodando = true;
    try {
      await db.setReativarUltimo(cfg.salao_id, t.data); // marca antes: nunca roda 2x no mesmo dia
      const [clientes, agendamentos, contatos, salao] = await Promise.all([
        db.listClientesSalao(cfg.salao_id), db.listAgendamentosSalao(cfg.salao_id), db.listReativacoes(cfg.salao_id), db.getSalaoNome(cfg.salao_id),
      ]);
      const meta = Number(cfg.reativar_max) || 15;
      const jaNaSemana = new Set(contatos.filter((c) => String(c.enviado_em).substring(0, 10) >= jan.inicio).map((c) => c.cliente_id)).size;
      const faltam = Math.max(0, meta - jaNaSemana);
      const hoje = Math.ceil(faltam / jan.diasRestantes); // espalha pela semana
      if (!hoje) return { ran: true, enviadas: 0, candidatas: 0, reason: 'meta_da_semana_cumprida' };
      const lista = selecionarLaser({
        clientes, agendamentos, contatos, hoje: t.data, servicoId: cfg.reativar_servico,
        minDias: Number(cfg.reativar_dias) || 30, limite: hoje,
      });
      const tpl = (cfg.reativar_msg || '').trim() || TEXTO_PADRAO;
      let enviadas = 0;
      for (const item of lista) {
        const texto = fill(tpl, { nome: String(item.cliente.nome || '').split(' ')[0], salao: salao || 'salão', data: fmtBR(jan.laser), dia: DIAS[dowDe(jan.laser)] });
        const r = await sendOne(item.cliente.whatsapp, texto);
        if (r.ok) {
          enviadas++;
          await db.insertReativacao({ salao_id: cfg.salao_id, cliente_id: item.cliente.id, enviado_em: now().toISOString() });
        } else if (r.error === 'whatsapp_desconectado') break;
        else log.warn?.({ cliente: item.cliente.id, erro: r.error }, 'reativação: não enviou');
        await sleep(pausaMinMs + Math.random() * Math.max(0, pausaMaxMs - pausaMinMs));
      }
      log.info?.({ enviadas, candidatas: lista.length, laser: jan.laser }, 'semana do laser: reativação concluída');
      return { ran: true, enviadas, candidatas: lista.length };
    } finally {
      rodando = false;
    }
  }
  return { tick };
}
