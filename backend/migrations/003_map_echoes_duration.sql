-- !! SUPERSEDED: do NOT run this file. night crawler's 004_place.sql (v2/night-crawler/004_place.sql) replaces it:
-- !! it adds duration_s to map_echoes too, plus place_kind / place_name / level. Run order: migration-v2.sql -> 004_place.sql.
-- !! Kept only for history.
-- 003_map_echoes_duration.sql — for night crawler, to run AFTER migration-v2.sql (not before; not instead of it).
-- Adds duration_s to map_echoes so the map card and the Nearby drawer can show each echo's length.
-- Play counts need nothing new: migration-v2 already has echoes.listen_count, record_listen() and returns
-- listen_count from map_echoes (the app calls record_listen when a hunt that played an echo is closed).
-- Same body as migration-v2's map_echoes plus one column; the return type changes, so drop + create.
begin;
drop function if exists public.map_echoes(double precision, double precision, double precision, double precision);
create function public.map_echoes(
  min_lat double precision, min_lng double precision, max_lat double precision, max_lng double precision
) returns table (
  id uuid, lat double precision, lng double precision, radius_m double precision,
  resonance_count integer, created_at timestamptz, expires_at timestamptz,
  heat double precision, blurred boolean, listen_count integer, reply_count integer,
  duration_s double precision                                   -- new in 003
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
  v_box := extensions.st_makeenvelope(min_lng - 0.0012, min_lat - 0.0009, max_lng + 0.0012, max_lat + 0.0009, 4326)::extensions.geography;
  return query
    select e.id, p.lat, p.lng, p.radius_m, e.resonance_count, e.created_at, e.expires_at,
           public._heat_now(e.heat, e.heat_at), e.blurred, e.listen_count, public._echo_reply_count(e.id),
           e.duration_s
      from public.echoes e
     cross join lateral public._echo_pin(e.id, e.location, e.blurred) p
     where public._echo_visible(e.hidden_at, e.expires_at, e.unlock_at)
       and extensions.st_intersects(e.location, v_box)
     order by e.created_at desc
     limit 1000;
end $$;
revoke all on function public.map_echoes(double precision, double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.map_echoes(double precision, double precision, double precision, double precision) to anon, authenticated, service_role;
commit;
