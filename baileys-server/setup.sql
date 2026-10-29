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
