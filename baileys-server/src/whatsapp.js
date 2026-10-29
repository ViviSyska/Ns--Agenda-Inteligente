// Gerencia a conexão do Baileys: QR, reconexão automática e eventos de mensagem.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { useSupabaseAuthState } from './supabase-auth-state.js';

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: demorou mais de ${Math.round(ms / 1000)}s`)), ms).unref()),
  ]);

export function createWhatsApp({ sb, session, log, onMessage }) {
  const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

  let sock = null;
  let status = 'close'; // 'close' | 'connecting' | 'open'
  let qr = null;
  let authApi = null;
  let connecting = false;
  let retries = 0;
  let stopped = false;
  let timer = null;

  const schedule = (ms) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => connect().catch((e) => log.error({ err: String(e) }, 'erro ao conectar')), ms);
  };

  async function connect() {
    if (connecting || stopped) return;
    connecting = true;
    try {
      status = 'connecting';
      authApi = await withTimeout(useSupabaseAuthState(sb, session), 90000, 'carregar sessão do banco');
      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        log.warn('não consegui buscar a versão mais recente do WhatsApp Web; usando a embutida');
      }

      sock = makeWASocket({
        ...(version ? { version } : {}),
        logger: baileysLogger,
        auth: {
          creds: authApi.state.creds,
          keys: makeCacheableSignalKeyStore(authApi.state.keys, baileysLogger),
        },
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
      });
      const mine = sock;

      mine.ev.on('creds.update', () => {
        authApi.saveCreds().catch((e) => log.error({ err: String(e) }, 'falha ao salvar credenciais'));
      });

      mine.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
          Promise.resolve(onMessage(m)).catch((e) => log.error({ err: String(e) }, 'erro ao processar mensagem'));
        }
      });

      mine.ev.on('connection.update', async (u) => {
        if (mine !== sock) return; // evento de um socket antigo
        if (u.qr) qr = u.qr;
        if (u.connection === 'connecting') status = 'connecting';
        if (u.connection === 'open') {
          status = 'open';
          qr = null;
          retries = 0;
          log.info({ user: mine.user?.id }, 'WhatsApp conectado');
        }
        if (u.connection === 'close') {
          status = 'close';
          const code = u.lastDisconnect?.error?.output?.statusCode;
          log.warn({ code }, 'conexão com o WhatsApp fechou');
          if (code === DisconnectReason.loggedOut) {
            // aparelho desconectado pelo celular: sessão inválida → apaga e gera QR novo
            try {
              await authApi.clear();
            } catch (e) {
              log.error({ err: String(e) }, 'falha ao limpar sessão');
            }
            qr = null;
            schedule(2000);
          } else if (code === DisconnectReason.connectionReplaced) {
            // outra instância assumiu a sessão (ex.: deploy em andamento) — espera antes de tentar
            schedule(60000);
          } else {
            retries++;
            schedule(Math.min(30000, 2000 * retries));
          }
        }
      });
    } catch (e) {
      // banco fora do ar, rede instável etc.: tenta de novo em vez de ficar parado
      status = 'close';
      retries++;
      log.error({ err: String(e?.message || e) }, 'falha ao iniciar a conexão; tentando de novo');
      schedule(Math.min(30000, 2000 * retries));
    } finally {
      connecting = false;
    }
  }

  return {
    start: () => connect(),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      try {
        sock?.end?.(undefined);
      } catch {}
    },
    getStatus: () => status,
    getSock: () => sock,
    getQR: () => qr,
    getUser: () => (status === 'open' ? sock?.user || null : null),
    async logout() {
      try {
        await sock?.logout?.();
      } catch (e) {
        log.warn({ err: String(e) }, 'logout falhou (seguindo com a limpeza)');
      }
      try {
        await authApi?.clear();
      } catch {}
      qr = null;
      status = 'close';
      schedule(1500);
    },
  };
}
