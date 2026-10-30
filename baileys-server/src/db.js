// Acesso ao banco do sistema (Supabase). Usa a service_role key — só no servidor!
import { createClient } from '@supabase/supabase-js';

export function createSupabase(url, serviceKey) {
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
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
    async listAguardando(clienteIds) {
      if (!clienteIds.length) return [];
      const { data, error } = await sb
        .from('agendamentos')
        .select('id,cliente_id,data,hora,status,wa_status')
        .in('cliente_id', clienteIds)
        .eq('wa_status', 'aguardando')
        .in('status', ['pendente', 'confirmado'])
        .order('data', { ascending: true })
        .order('hora', { ascending: true });
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
        .select('id,direction,text,ts,jid,phone,nome,lida')
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
      const { error } = await sb.from('agendamentos').update(fields).eq('id', id);
      if (error) throw error;
    },
  };
}
