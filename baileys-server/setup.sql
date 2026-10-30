-- ============================================================
-- Servidor WhatsApp (Baileys) — rode UMA vez no SQL Editor do Supabase
-- ============================================================

-- Guarda a sessão do WhatsApp. Assim, quando o servidor dorme (Render grátis)
-- e acorda, ele reconecta sozinho, sem escanear o QR Code de novo.
create table if not exists wa_auth (
  session    text        not null,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (session, id)
);

-- Segurança: RLS ligada e SEM nenhuma policy => ninguém acessa pela chave "anon"
-- (a do sistema). Só o servidor, com a service_role key, consegue ler/gravar.
alter table wa_auth enable row level security;
revoke all on table wa_auth from anon, authenticated;

-- Garantias (já existem no seu banco se você rodou os scripts anteriores)
alter table agendamentos add column if not exists wa_status text;

-- Conferência: deve listar a tabela wa_auth com rls = true
select tablename, rowsecurity as rls from pg_tables where tablename = 'wa_auth';

-- ============================================================
-- CAIXA DE MENSAGENS (conversas do WhatsApp dentro do sistema)
-- ============================================================
create table if not exists wa_msgs (
  id         uuid        primary key default gen_random_uuid(),
  chat_key   text        not null,          -- DDD + 8 últimos dígitos (identifica a cliente)
  phone      text,
  jid        text,
  nome       text,
  direction  text        not null check (direction in ('in','out')),
  text       text        not null,
  wa_id      text        unique,            -- id da mensagem no WhatsApp (evita duplicar)
  ts         timestamptz not null default now(),
  lida       boolean     not null default false
);
create index if not exists idx_wa_msgs_chat on wa_msgs (chat_key, ts);
create index if not exists idx_wa_msgs_ts   on wa_msgs (ts desc);
alter table wa_msgs enable row level security;   -- sem policy: só o servidor (service_role) acessa
revoke all on table wa_msgs from anon, authenticated;
select tablename, rowsecurity as rls from pg_tables where tablename in ('wa_auth','wa_msgs');
