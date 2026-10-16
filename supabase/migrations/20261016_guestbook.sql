create schema if not exists private_guestbook;
revoke all on schema private_guestbook from public, anon, authenticated;

create table if not exists public.guestbook_messages (
  id uuid primary key default gen_random_uuid(),
  content text not null check (char_length(btrim(content)) between 1 and 280),
  created_at timestamptz not null default now()
);

alter table public.guestbook_messages enable row level security;
drop policy if exists guestbook_messages_public_read on public.guestbook_messages;
create policy guestbook_messages_public_read
  on public.guestbook_messages
  for select
  to anon, authenticated
  using (true);
revoke all on table public.guestbook_messages from public, anon, authenticated;
grant select on table public.guestbook_messages to anon, authenticated;

create table if not exists private_guestbook.guestbook_cooldowns (
  visitor_id uuid primary key,
  last_post_at timestamptz not null
);
alter table private_guestbook.guestbook_cooldowns enable row level security;
revoke all on table private_guestbook.guestbook_cooldowns from public, anon, authenticated;

create or replace function public.submit_guestbook_message(p_content text, p_visitor_id uuid)
returns table (id uuid, content text, created_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, private_guestbook
as $$
declare
  clean_content text := btrim(p_content);
  accepted_visitor uuid;
  inserted_message public.guestbook_messages%rowtype;
begin
  if p_visitor_id is null then
    raise exception using errcode = '22023', message = 'invalid_visitor';
  end if;
  if clean_content is null or char_length(clean_content) < 1 or char_length(clean_content) > 280 then
    raise exception using errcode = '22023', message = 'invalid_content_length';
  end if;

  insert into private_guestbook.guestbook_cooldowns (visitor_id, last_post_at)
  values (p_visitor_id, now())
  on conflict (visitor_id) do update
    set last_post_at = excluded.last_post_at
    where private_guestbook.guestbook_cooldowns.last_post_at <= now() - interval '30 seconds'
  returning visitor_id into accepted_visitor;

  if accepted_visitor is null then
    raise exception using errcode = 'P0001', message = 'rate_limited';
  end if;

  insert into public.guestbook_messages (content)
  values (clean_content)
  returning * into inserted_message;

  return query select inserted_message.id, inserted_message.content, inserted_message.created_at;
end;
$$;

revoke all on function public.submit_guestbook_message(text, uuid) from public, authenticated;
grant execute on function public.submit_guestbook_message(text, uuid) to anon;
