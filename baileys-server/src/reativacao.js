// Reativação automática: chama de volta clientes que sumiram (prazo fixo), com limite por dia,
// horário comercial, sem repetir a mesma cliente e respeitando quem pediu para parar.
import { phoneKey } from './phone.js';

const dayMs = 86400000;
const diffDias = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / dayMs);

/** Escolhe quem chamar hoje. Mesma regra do relatório "Sumidas" do app. */
export function selecionar({ clientes, agendamentos, contatos = [], hoje, dias = 60, cooldownDias = 90, max = 8 }) {
  const porCli = new Map();
  for (const a of agendamentos) {
    const o = porCli.get(a.cliente_id) || { ultima: null, visitas: 0, futura: false };
    const d = String(a.data || '').substring(0, 10);
    if (a.status === 'concluido') {
      o.visitas++;
      if (!o.ultima || d > o.ultima) o.ultima = d;
    } else if ((a.status === 'pendente' || a.status === 'confirmado') && d >= hoje) o.futura = true;
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
    if (!k || vistos.has(k)) continue; // mesmo telefone em 2 cadastros: só uma mensagem
    const o = porCli.get(c.id);
    if (!o || !o.ultima || o.futura) continue;
    const sumiu = diffDias(o.ultima, hoje);
    if (sumiu <= dias) continue;
    const uc = ultimoContato.get(c.id);
    if (uc && diffDias(uc, hoje) < cooldownDias) continue;
    vistos.add(k);
    out.push({ cliente: c, sumiuDias: sumiu, visitas: o.visitas });
  }
  // quem mais vinha primeiro; depois a visita mais recente
  out.sort((a, b) => b.visitas - a.visitas || a.sumiuDias - b.sumiuDias);
  return out.slice(0, max);
}

const brParts = (now) => {
  const s = now.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // 2026-10-30 18:57:00
  return { data: s.slice(0, 10), hora: Number(s.slice(11, 13)), dow: new Date(s.slice(0, 10) + 'T12:00:00Z').getUTCDay() };
};

export const TEXTO_PADRAO =
  'Oi {nome}! Tudo bem? 💛 Sentimos sua falta por aqui no {salao}. Vamos marcar o seu horário? É só me responder por aqui!';
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export function createReativacao({ db, wa, sendOne, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), horaIni = 10, horaFim = 17, pausaMinMs = 30000, pausaMaxMs = 90000, salaoId = null }) {
  let rodando = false;

  async function tick() {
    if (rodando) return { ran: false, reason: 'ocupado' };
    const cfg = await db.getReativacaoCfg(salaoId);
    if (!cfg || !cfg.reativar_on) return { ran: false, reason: 'desligado' };
    const t = brParts(now());
    if (t.dow === 0 || t.hora < horaIni || t.hora >= horaFim) return { ran: false, reason: 'fora_do_horario' };
    if (String(cfg.reativar_ultimo || '') === t.data) return { ran: false, reason: 'ja_rodou_hoje' };
    if (wa.getStatus() !== 'open') return { ran: false, reason: 'whatsapp_desconectado' };
    rodando = true;
    try {
      await db.setReativarUltimo(cfg.salao_id, t.data); // marca antes: nunca roda 2x no mesmo dia
      const [clientes, agendamentos, contatos, salao] = await Promise.all([
        db.listClientesSalao(cfg.salao_id), db.listAgendamentosSalao(cfg.salao_id), db.listReativacoes(cfg.salao_id), db.getSalaoNome(cfg.salao_id),
      ]);
      const lista = selecionar({ clientes, agendamentos, contatos, hoje: t.data, dias: Number(cfg.reativar_dias) || 60, max: Number(cfg.reativar_max) || 8 });
      const tpl = (cfg.reativar_msg || '').trim() || TEXTO_PADRAO;
      let enviadas = 0;
      for (const item of lista) {
        const texto = fill(tpl, { nome: String(item.cliente.nome || '').split(' ')[0], salao: salao || 'salão' });
        const r = await sendOne(item.cliente.whatsapp, texto);
        if (r.ok) {
          enviadas++;
          await db.insertReativacao({ salao_id: cfg.salao_id, cliente_id: item.cliente.id, enviado_em: now().toISOString() });
        } else if (r.error === 'whatsapp_desconectado') break;
        else log.warn?.({ cliente: item.cliente.id, erro: r.error }, 'reativação: não enviou');
        await sleep(pausaMinMs + Math.random() * Math.max(0, pausaMaxMs - pausaMinMs));
      }
      log.info?.({ enviadas, candidatas: lista.length }, 'reativação concluída');
      return { ran: true, enviadas, candidatas: lista.length };
    } finally {
      rodando = false;
    }
  }
  return { tick };
}
