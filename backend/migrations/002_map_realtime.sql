-- =============================================================================
--  Echolocation · migration 002: shared live map (server-side fuzz + Realtime)
--  Run ONCE in Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
--  Idempotent: safe to re-run. Needs schema.sql (night crawler's backend) applied first.
--
--  What it adds:
--    1. A secret salt (never readable by clients) used to fuzz echo positions.
--    2. public.map_echoes(min_lat, min_lng, max_lat, max_lng): every live echo in a viewport, with
--       a FUZZED centre (30–60 m glow that contains the real spot) computed in the database.
--       Exact coordinates never leave the database through this function.
--    3. A trigger that broadcasts drop / update / gone on the public Realtime topic 'echo-map'
--       (fuzzed position only), so every open map updates within ~1 s.
--  The web app detects map_echoes by itself (re-checks every minute). No app change is needed.
-- =============================================================================

-- 1. secret salt --------------------------------------------------------------
create table if not exists public.echo_private_salt (
  id   boolean primary key default true check (id),
  salt text    not null
);
insert into public.echo_private_salt (id, salt)
values (true, md5(random()::text || clock_timestamp()::text) || md5(random()::text || pg_backend_pid()::text))
on conflict (id) do nothing;
alter table public.echo_private_salt enable row level security;
revoke all on table public.echo_private_salt from public, anon, authenticated;

-- 2. fuzz helper: stable per echo, keyed on the secret salt -------------------------
--    radius 30–60 m; centre moved 15–75 % of the radius in a salted direction; rounded to ~1 m.
create or replace function public._echo_fuzz(p_id uuid, p_loc extensions.geography)
returns table (lat double precision, lng double precision, radius_m double precision)
language plpgsql stable security definer set search_path = '' as $$
declare h text; u1 double precision; u2 double precision; u3 double precision;
        r double precision; c extensions.geography;
begin
  select md5(s.salt || p_id::text) into h from public.echo_private_salt s where s.id;
  if h is null then h := md5('echolocation' || p_id::text); end if;
  u1 := ('x' || lpad(substr(h, 1, 8), 16, '0'))::bit(64)::bigint / 4294967296.0;
  u2 := ('x' || lpad(substr(h, 9, 8), 16, '0'))::bit(64)::bigint / 4294967296.0;
  u3 := ('x' || lpad(substr(h, 17, 8), 16, '0'))::bit(64)::bigint / 4294967296.0;
  r  := 30 + 30 * u1;
  c  := extensions.st_project(p_loc, r * (0.15 + 0.6 * u2), radians(360 * u3));
  lat := round(extensions.st_y(c::extensions.geometry)::numeric, 5)::double precision;
  lng := round(extensions.st_x(c::extensions.geometry)::numeric, 5)::double precision;
  radius_m := round(r::numeric, 1)::double precision;
  return next;
end $$;
revoke all on function public._echo_fuzz(uuid, extensions.geography) from public, anon, authenticated;

-- 3. map_echoes: the map's only read path -------------------------------------------
create or replace function public.map_echoes(
  min_lat double precision, min_lng double precision, max_lat double precision, max_lng double precision
) returns table (
  id uuid, lat double precision, lng double precision, radius_m double precision,
  resonance_count integer, created_at timestamptz, expires_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare v_box extensions.geography;
begin
  if min_lat is null or min_lng is null or max_lat is null or max_lng is null
     or min_lat <> min_lat or min_lng <> min_lng or max_lat <> max_lat or max_lng <> max_lng
     or min_lat < -90 or max_lat > 90 or min_lng < -180 or max_lng > 180
     or min_lat >= max_lat or min_lng >= max_lng then
    raise exception 'invalid viewport' using errcode = '22023';
  end if;
  if max_lat - min_lat > 2 or max_lng - min_lng > 2 then
    raise exception 'viewport too large (max 2 degrees)' using errcode = '22023';
  end if;
  -- pad by ~100 m so glows whose centre sits just outside the view are still drawn
  v_box := extensions.st_makeenvelope(min_lng - 0.0012, min_lat - 0.0009, max_lng + 0.0012, max_lat + 0.0009, 4326)::extensions.geography;
  return query
    select e.id, f.lat, f.lng, f.radius_m, e.resonance_count, e.created_at, e.expires_at
      from public.echoes e
     cross join lateral public._echo_fuzz(e.id, e.location) f
     where e.expires_at > now()
       and extensions.st_intersects(e.location, v_box)
     order by e.created_at desc
     limit 1000;
end $$;
revoke all on function public.map_echoes(double precision, double precision, double precision, double precision) from public;
grant execute on function public.map_echoes(double precision, double precision, double precision, double precision) to anon, authenticated;

-- 4. Realtime: broadcast every change on the public topic 'echo-map' (fuzzed only) -------
--    Uses Supabase's realtime.send(payload, event, topic, private). private = false -> any client with the
--    publishable key can subscribe; nothing exact is ever sent. A broadcast failure never blocks a drop.
create or replace function public._echo_map_broadcast()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare f record;
begin
  if tg_op = 'DELETE' then
    perform realtime.send(jsonb_build_object('id', old.id), 'gone', 'echo-map', false);
    return old;
  end if;
  select * into f from public._echo_fuzz(new.id, new.location);
  perform realtime.send(
    jsonb_build_object('id', new.id, 'lat', f.lat, 'lng', f.lng, 'radius_m', f.radius_m,
                       'resonance_count', new.resonance_count, 'created_at', new.created_at,
                       'expires_at', new.expires_at, 'fuzz', 'server'),
    case when tg_op = 'INSERT' then 'drop' else 'update' end, 'echo-map', false);
  return new;
exception when others then
  raise warning 'echo-map broadcast skipped: %', sqlerrm;
  return coalesce(new, old);
end $$;
revoke all on function public._echo_map_broadcast() from public, anon, authenticated;

drop trigger if exists echoes_map_broadcast on public.echoes;
create trigger echoes_map_broadcast
  after insert or delete or update of resonance_count, expires_at on public.echoes
  for each row execute function public._echo_map_broadcast();

-- 5. OPTIONAL hardening (leave commented while the hidden debug map is still wanted) ------
--    debug_echoes() returns exact positions for /debug.html. Once you no longer need the debug map:
-- revoke execute on function public.debug_echoes(double precision,double precision,double precision) from anon, authenticated;

-- Quick check (should return 1 row each):
-- select proname from pg_proc where proname in ('map_echoes', '_echo_fuzz', '_echo_map_broadcast');
-- select tgname from pg_trigger where tgname = 'echoes_map_broadcast';
