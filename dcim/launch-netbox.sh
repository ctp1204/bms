#!/bin/bash
# Bản sao /opt/netbox/launch-netbox.sh của image netboxcommunity/netbox:v4.7.3-5.1.1, chỉ khác một chỗ:
# đường dẫn file tĩnh theo BASE_PATH (/netbox/static thay vì /static), vì NetBox chạy dưới /netbox/.
# Khi nâng phiên bản image, so lại với bản gốc: docker compose exec netbox cat /opt/netbox/launch-netbox.sh

export GRANIAN_PORT=${GRANIAN_PORT:-8080}
export GRANIAN_WORKERS=${GRANIAN_WORKERS:-4}

exec granian \
  --host "::" \
  --interface "wsgi" \
  --no-ws \
  --respawn-failed-workers \
  --loop "uvloop" \
  --log \
  --log-level "info" \
  --access-log \
  --working-dir "/opt/netbox/netbox/" \
  --static-path-route "/${BASE_PATH}static" \
  --static-path-mount "/opt/netbox/netbox/static/" \
  --static-path-dir-to-file index.html \
  --pid-file "/tmp/granian.pid" \
  "${GRANIAN_EXTRA_ARGS[@]}" \
  "netbox.granian:application"
