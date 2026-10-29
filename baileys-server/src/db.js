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

    async updateAgendamento(id, fields) {
      const { error } = await sb.from('agendamentos').update(fields).eq('id', id);
      if (error) throw error;
    },
  };
}
