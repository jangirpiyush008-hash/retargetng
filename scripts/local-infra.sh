#!/usr/bin/env bash
# Start/stop local Postgres 16 + Redis installed via Homebrew (no Docker needed).
#   scripts/local-infra.sh start|stop|status
set -euo pipefail
PG_BIN=/opt/homebrew/opt/postgresql@16/bin
PG_DATA=/opt/homebrew/var/postgresql@16
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
case "${1:-start}" in
  start)
    if [ ! -f "$PG_DATA/PG_VERSION" ]; then
      "$PG_BIN/initdb" --locale=en_US.UTF-8 -E UTF-8 -U postgres -D "$PG_DATA"
    fi
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_DATA/server.log" status >/dev/null 2>&1 || \
      "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$PG_DATA/server.log" start
    sleep 1
    "$PG_BIN/psql" -U postgres -tAc "select 1 from pg_roles where rolname='aap'" | grep -q 1 || \
      "$PG_BIN/psql" -U postgres -c "create user aap with password 'aap' superuser;"
    for db in aap aap_test; do
      "$PG_BIN/psql" -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || \
        "$PG_BIN/createdb" -U postgres -O aap "$db"
    done
    redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save "" --appendonly no >/dev/null
    echo "postgres: $( "$PG_BIN/pg_ctl" -D "$PG_DATA" status | head -1 )"
    echo "redis: $(redis-cli ping)"
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$PG_DATA" stop || true
    redis-cli shutdown nosave || true
    ;;
  status)
    "$PG_BIN/pg_ctl" -D "$PG_DATA" status || true
    redis-cli ping || true
    ;;
esac
