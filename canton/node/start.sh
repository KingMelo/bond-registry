#!/bin/sh
# Railway's Postgres gives one database; Canton's three parts each keep their own.
set -e
for db in canton_participant canton_sequencer canton_sequencer_driver canton_mediator; do
  psql "postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/${PGDATABASE:-postgres}" -tAc "select 1 from pg_database where datname = '$db'" | grep -q 1 \
    || psql "postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/${PGDATABASE:-postgres}" -c "create database $db"
done
exec java ${JAVA_OPTS:--Xms512m -Xmx1536m} -jar /canton/canton.jar daemon --no-tty \
  -c /canton/node.conf --bootstrap /canton/node.canton --log-file-appender off --log-level-stdout INFO
