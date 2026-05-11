-- =============================================================================
-- Jarvis – Supabase schema bootstrap
-- =============================================================================
-- Idempotent: safe to run multiple times.
--
-- Holds:
--   - jarvis.chat_context     per-chat summaries + AGENTS.md-style notes
--   - jarvis.wa_webhook_seen  webhook idempotency keys (X-Webhook-Id, 24h TTL)
--
-- The langgraph PostgresSaver creates its own tables (checkpoints,
-- checkpoint_blobs, checkpoint_writes) in the public schema via `.setup()`
-- when the WA server boots.
-- =============================================================================

create schema if not exists jarvis;

-- One row per WhatsApp chat. Created lazily by the runner on first use.
create table if not exists jarvis.chat_context (
  chat_jid              text primary key,

  -- Rolling 24h summary. Refreshed lazily (when stale) or by the cron worker.
  daily_summary         text,
  daily_updated_at      timestamptz,
  daily_through_seq     bigint,

  -- Rolling 7d summary.
  weekly_summary        text,
  weekly_updated_at     timestamptz,
  weekly_through_seq    bigint,

  -- Everything older than 7d, highly compressed.
  longterm_summary      text,
  longterm_updated_at   timestamptz,
  longterm_through_seq  bigint,

  -- AGENTS.md-style notes the agent maintains via `whatsapp_remember`.
  -- Always injected verbatim into the system context.
  notes                 text not null default '',
  notes_updated_at      timestamptz,

  -- Operator kill-switch. When false the dispatcher drops messages on the
  -- floor. Toggle via SQL for now; a `/jarvis on|off` chat command is v2.
  enabled               boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Bump updated_at on every write.
create or replace function jarvis._touch_chat_context()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists chat_context_touch on jarvis.chat_context;
create trigger chat_context_touch
  before update on jarvis.chat_context
  for each row execute function jarvis._touch_chat_context();


-- Webhook idempotency keys. The Fastify app inserts on every received delivery
-- and treats unique-violation as "already seen, ignore".
create table if not exists jarvis.wa_webhook_seen (
  id          text primary key,
  expires_at  timestamptz not null default (now() + interval '24 hours'),
  seen_at     timestamptz not null default now()
);

create index if not exists wa_webhook_seen_expires_at
  on jarvis.wa_webhook_seen (expires_at);

-- Helper for periodic cleanup (call from a cron or whenever convenient).
create or replace function jarvis.purge_expired_webhooks()
returns int
language sql
as $$
  with deleted as (
    delete from jarvis.wa_webhook_seen
    where expires_at < now()
    returning id
  )
  select count(*)::int from deleted;
$$;
