#!/usr/bin/env bash
# Tạo tổ chức, nhóm xử lý, người báo và tài khoản API trong iTop. Chạy sau install.sh; chạy lại được.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${ITSM_PASSWORD:?Thiếu ITSM_PASSWORD trong .env}"

docker compose cp ../config/itsm.json itop:/tmp/itsm.json
docker compose cp bootstrap.php itop:/tmp/bootstrap.php
docker compose exec -T -u www-data -e ITSM_USER="${ITSM_USER:-bms-itsm}" -e ITSM_PASSWORD="$ITSM_PASSWORD" \
  -e ITSM_CMDB_USER="${ITSM_CMDB_USER:-bms-cmdb}" -e ITSM_CMDB_PASSWORD="${ITSM_CMDB_PASSWORD:-}" itop \
  php /tmp/bootstrap.php /tmp/itsm.json
