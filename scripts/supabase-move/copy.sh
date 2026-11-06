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
echo "[move] source: $(psql "$SOURCE_URL" -tAc 'select version()' | cut -c1-40)"
echo "[move] target: $(psql "$TARGET_URL" -tAc 'select version()' | cut -c1-40)"
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
echo "[move] done: every table has the same rows"
