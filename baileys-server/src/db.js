// Acesso ao banco do sistema (Supabase). Usa a service_role key — só no servidor!
import { createClient } from '@supabase/supabase-js';

export function createSupabase(url, serviceKey) {
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Lê todas as linhas (o Supabase devolve no máximo 1000 por consulta)
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function createDb(sb) {
  return {
    /** Clientes com WhatsApp: [{ id, nome, whatsapp }] */
    async listClientes() {
      const { data, error } = await sb.from('clientes').select('id,nome,whatsapp').not('whatsapp', 'is', null);
      if (error) throw error;
      return data || [];
    },

    /** Agendamentos aguardando resposta dessas clientes (ainda ativos), do mais próximo pro mais distante. */
    // ---------- código de segurança do login ----------
    async getUsuarioDoToken(token) {
      const { data, error } = await sb.auth.getUser(token);
      return error || !data?.user ? null : data.user;
    },
    async getSeguranca(userId) {
      const { data } = await sb.from('seguranca').select('whatsapp,exigir_codigo').eq('user_id', userId).maybeSingle();
      return data || null;
    },
    async codigosRecentes(userId, desdeIso) {
      const { data, error } = await sb.from('login_codigos').select('criado_em').eq('user_id', userId).gte('criado_em', desdeIso).order('criado_em', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async criarCodigo(row) {
      await sb.from('login_codigos').update({ usado: true }).eq('user_id', row.user_id).eq('session_id', row.session_id).eq('usado', false);
      const { data, error } = await sb.from('login_codigos').insert(row).select('id').single();
      if (error) throw error;
      return data.id;
    },
    async invalidarCodigo(id) {
      await sb.from('login_codigos').update({ usado: true }).eq('id', id);
    },

    async marcarAguardando(id, iso) {
      const run = (f) => sb.from('agendamentos').update(f).eq('id', id).or('wa_status.is.null,wa_status.neq.confirmou');
      let { error } = await run({ wa_status: 'aguardando', wa_enviado_em: iso });
      if (error && /wa_enviado_em/.test(error.message || '')) ({ error } = await run({ wa_status: 'aguardando' }));
      if (error) throw error;
    },
    async listAguardando(clienteIds) {
      if (!clienteIds.length) return [];
      const run = (cols) => sb
        .from('agendamentos')
        .select(cols)
        .in('cliente_id', clienteIds)
        .eq('wa_status', 'aguardando')
        .in('status', ['pendente', 'confirmado'])
        .order('data', { ascending: true })
        .order('hora', { ascending: true });
      let { data, error } = await run('id,cliente_id,data,hora,status,wa_status,wa_enviado_em');
      if (error && /wa_enviado_em/.test(error.message || '')) ({ data, error } = await run('id,cliente_id,data,hora,status,wa_status'));
      if (error) throw error;
      return data || [];
    },

    /** Guarda uma mensagem do chat. wa_id é único: repetida é ignorada. */
    async insertMessage(row) {
      const q = row.wa_id
        ? sb.from('wa_msgs').upsert(row, { onConflict: 'wa_id', ignoreDuplicates: true })
        : sb.from('wa_msgs').insert(row);
      const { error } = await q;
      if (error) throw error;
    },

    /** Últimas mensagens (para montar a lista de conversas). */
    async listRecentMessages(limit = 600) {
      const { data, error } = await sb
        .from('wa_msgs')
        .select('chat_key,phone,jid,nome,direction,text,ts,lida')
        .order('ts', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },

    /** Mensagens de uma conversa em ordem cronológica. */
    async listChatMessages(chatKey, limit = 150) {
      const { data, error } = await sb
        .from('wa_msgs')
        .select('id,direction,text,ts,jid,phone,nome,lida,wa_id')
        .eq('chat_key', chatKey)
        .order('ts', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).reverse();
    },

    async markChatRead(chatKey) {
      const { error } = await sb.from('wa_msgs').update({ lida: true }).eq('chat_key', chatKey).eq('direction', 'in').eq('lida', false);
      if (error) throw error;
    },

    async updateAgendamento(id, fields) {
      let { error } = await sb.from('agendamentos').update(fields).eq('id', id);
      // banco ainda sem a coluna wa_enviado_em: grava o resto
      if (error && 'wa_enviado_em' in fields && /wa_enviado_em/.test(error.message || '')) {
        const { wa_enviado_em, ...resto } = fields;
        ({ error } = await sb.from('agendamentos').update(resto).eq('id', id));
      }
      if (error) throw error;
    },

    // ---------- reativação de clientes sumidas ----------
    async listAutomacoes(salaoId) {
      let q = sb.from('automacoes').select('*').eq('ativa', true);
      if (salaoId) q = q.eq('salao_id', salaoId);
      const { data, error } = await q.order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    async setAutomacaoUltimo(id, dia) {
      const { error } = await sb.from('automacoes').update({ ultimo_envio: dia }).eq('id', id);
      if (error) throw error;
    },
    async listServicosNomes(salaoId) {
      const { data } = await sb.from('servicos').select('id,nome').eq('salao_id', salaoId);
      return new Map((data || []).map((x) => [x.id, x.nome]));
    },
    listClientesSalao(salaoId) {
      return fetchAll(() => sb.from('clientes').select('id,nome,whatsapp,nao_contatar').eq('salao_id', salaoId).not('whatsapp', 'is', null).order('id'));
    },
    listAgendamentosSalao(salaoId) {
      return fetchAll(() => sb.from('agendamentos').select('id,cliente_id,data,status,agendamento_servicos(servico_id)').eq('salao_id', salaoId).order('id'))
        .then((rows) => rows.map((a) => ({ id: a.id, cliente_id: a.cliente_id, data: a.data, status: a.status, servicos: (a.agendamento_servicos || []).map((x) => x.servico_id) })));
    },
    async listReativacoes(salaoId) {
      const { data, error } = await sb.from('reativacoes').select('cliente_id,enviado_em,automacao_id').eq('salao_id', salaoId).order('enviado_em', { ascending: false }).limit(2000);
      if (error) throw error;
      return data || [];
    },
    async insertReativacao(row) {
      let { error } = await sb.from('reativacoes').insert(row);
      if (error && /automacao_id/.test(error.message || '')) { const { automacao_id, ...resto } = row; ({ error } = await sb.from('reativacoes').insert(resto)); }
      if (error) throw error;
    },
    async getSalaoNome(salaoId) {
      const { data } = await sb.from('saloes').select('nome').eq('id', salaoId).maybeSingle();
      return data?.nome || '';
    },
    async setNaoContatar(ids) {
      if (!ids.length) return;
      const { error } = await sb.from('clientes').update({ nao_contatar: true }).in('id', ids);
      if (error) throw error;
    },
  };
}
