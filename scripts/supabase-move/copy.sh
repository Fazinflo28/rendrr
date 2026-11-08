#!/bin/sh
# Copies the whole Rendrr database (schema, data and Prisma's migration history) from Railway Postgres to Supabase.
# Runs as a one-off Railway service so the connection strings never leave Railway:
#   SOURCE_URL = the Railway Postgres URL (reference ${{Postgres.DATABASE_URL}})
#   TARGET_URL = Supabase's Session pooler URL (reference ${{shared.SUPABASE_DIRECT_URL}})
# The target must be empty. Tables are created first, then the data, then the keys and indexes (pg_restore's order),
# so foreign keys never block the load. Ends by comparing row counts table by table.
set -eu
: "${SOURCE_URL:?SOURCE_URL is not set}"
: "${TARGET_URL:?TARGET_URL is not set}"
host() { echo "$1" | sed -E 's#^[a-z]+://.*@##; s#[/?].*$##'; }  # host:port only, never the user or password
echo "[move] source: $(host "$SOURCE_URL"), $(psql "$SOURCE_URL" -tAc 'select version()' | cut -c1-40)"
echo "[move] target: $(host "$TARGET_URL"), $(psql "$TARGET_URL" -tAc 'select version()' | cut -c1-40)"
# How far the target is from here (the region): 10 round trips, median in ms.
ms() { { printf '%s\n' '\timing on'; for i in 1 2 3 4 5 6 7 8 9 10; do printf 'select 1;\n'; done; } | psql "$1" -At 2>/dev/null | sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' | sort -n | sed -n 5p; }
echo "[move] round trip: source $(ms "$SOURCE_URL") ms, target $(ms "$TARGET_URL") ms"
# RESET_TARGET=1: empty the target first (it holds an older copy). Refused when the target has newer data than the
# source (newest job log or usage event), which means the app already uses it: a live database is never emptied.
if [ "${RESET_TARGET:-}" = "1" ]; then
  newest() { psql "$1" -tAc "select coalesce(greatest((select max(\"createdAt\") from public.\"JobLog\"), (select max(\"createdAt\") from public.\"UsageEvent\")), 'epoch')::text" 2>/dev/null || echo "1970-01-01 00:00:00"; }
  s=$(newest "$SOURCE_URL"); t=$(newest "$TARGET_URL")
  echo "[move] newest data: source $s, target $t"
  if [ "$t" \> "$s" ]; then echo "[move] the target has newer data than the source: it is in use, not emptying it"; exit 1; fi
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname = 'public' loop execute format('drop table if exists public.%I cascade', r.tablename); end loop;
  for r in select sequence_name from information_schema.sequences where sequence_schema = 'public' loop execute format('drop sequence if exists public.%I cascade', r.sequence_name); end loop;
  for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e' loop execute format('drop type if exists public.%I cascade', r.typname); end loop;
end $$;
SQL
  echo "[move] target emptied (it held an older copy)"
fi
existing=$(psql "$TARGET_URL" -tAc "select count(*) from information_schema.tables where table_schema='public'")
if [ "$existing" != "0" ] && [ "${ALLOW_NON_EMPTY:-}" != "1" ]; then echo "[move] the target already has $existing tables in public: stopping (set ALLOW_NON_EMPTY=1 to load anyway)"; exit 1; fi
pg_dump --format=custom --no-owner --no-acl --schema=public --file=/tmp/rendrr.dump "$SOURCE_URL"
echo "[move] dump: $(du -h /tmp/rendrr.dump | cut -f1)"
# Settings a newer pg_dump writes that an older server does not know are skipped by pg_restore with a warning.
pg_restore --no-owner --no-acl --jobs=2 --dbname="$TARGET_URL" /tmp/rendrr.dump || true
fail=0
for t in $(psql "$SOURCE_URL" -tAc "select tablename from pg_tables where schemaname='public' order by 1"); do
  a=$(psql "$SOURCE_URL" -tAc "select count(*) from public.\"$t\"")
  b=$(psql "$TARGET_URL" -tAc "select count(*) from public.\"$t\"" 2>/dev/null || echo missing)
  if [ "$a" = "$b" ]; then echo "[move] $t: $a rows"; else echo "[move] $t: source $a, target $b  <-- DIFFERENT"; fail=1; fi
done
if [ "$fail" = "1" ]; then echo "[move] row counts differ: do not switch over"; exit 1; fi
# On Supabase: nothing in public is reachable through its Data API (the anon and authenticated roles), now or for
# tables made later, and row level security is on for every table (Rendrr connects as the owner, which it does not
# limit). Skipped on a plain Postgres target, which has no such roles.
if [ "$(psql "$TARGET_URL" -tAc "select count(*) from pg_roles where rolname in ('anon','authenticated')")" = "2" ]; then
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname = 'public' loop execute format('alter table public.%I enable row level security', t); end loop; end $$;
SQL
  echo "[move] locked down: public tables closed to Supabase's Data API roles, row level security on"
fi
echo "[move] done: every table has the same rows"
