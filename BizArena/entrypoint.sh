#!/bin/sh
# Seed db.json and initial snapshots from db_initial.json
for app in scrumboard teams outlook; do
  if [ -f /app/$app/db_initial.json ]; then
    cp /app/$app/db_initial.json /app/$app/db.json
    cp /app/$app/db_initial.json /app/$app/localStorage_snapshot.json
  fi
  : > /app/$app/event_log.ndjson
done

node /app/scrumboard/server.js &
node /app/outlook/server.js &
node /app/teams/server.js &

wait -n
exit $?
