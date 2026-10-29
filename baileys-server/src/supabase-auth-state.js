// Guarda a sessão do WhatsApp no Supabase (tabela wa_auth) em vez de arquivos locais.
// Assim, quando o Render "dorme" e acorda, o servidor recarrega a sessão e reconecta
// sozinho — sem precisar escanear o QR Code de novo.
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const TABLE = 'wa_auth';
const CHUNK = 100;

const encode = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const decode = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`[wa_auth] ${label} falhou: ${lastErr?.message || lastErr}`);
}

const chunks = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export async function useSupabaseAuthState(sb, session) {
  const read = (id) =>
    withRetry(async () => {
      const { data, error } = await sb.from(TABLE).select('data').eq('session', session).eq('id', id).maybeSingle();
      if (error) throw error;
      return data ? decode(data.data) : null;
    }, `ler ${id}`);

  const upsert = (rows) =>
    withRetry(async () => {
      for (const part of chunks(rows, 200)) {
        const { error } = await sb.from(TABLE).upsert(part, { onConflict: 'session,id' });
        if (error) throw error;
      }
    }, 'gravar');

  const remove = (ids) =>
    withRetry(async () => {
      for (const part of chunks(ids, CHUNK)) {
        const { error } = await sb.from(TABLE).delete().eq('session', session).in('id', part);
        if (error) throw error;
      }
    }, 'apagar');

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const part of chunks(ids, CHUNK)) {
            const wanted = part.map((id) => `${type}-${id}`);
            const rows = await withRetry(async () => {
              const { data, error } = await sb.from(TABLE).select('id,data').eq('session', session).in('id', wanted);
              if (error) throw error;
              return data || [];
            }, `ler ${type}`);
            const byId = new Map(rows.map((r) => [r.id, r.data]));
            for (const id of part) {
              let value = byId.has(`${type}-${id}`) ? decode(byId.get(`${type}-${id}`)) : null;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              out[id] = value;
            }
          }
          return out;
        },
        set: async (data) => {
          const rows = [];
          const toDelete = [];
          const now = new Date().toISOString();
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) rows.push({ session, id: key, data: encode(value), updated_at: now });
              else toDelete.push(key);
            }
          }
          if (rows.length) await upsert(rows);
          if (toDelete.length) await remove(toDelete);
        },
      },
    },
    saveCreds: () => upsert([{ session, id: 'creds', data: encode(creds), updated_at: new Date().toISOString() }]),
    /** Apaga a sessão inteira (usado quando o WhatsApp desloga o aparelho). */
    clear: () =>
      withRetry(async () => {
        const { error } = await sb.from(TABLE).delete().eq('session', session);
        if (error) throw error;
      }, 'limpar sessão'),
  };
}
