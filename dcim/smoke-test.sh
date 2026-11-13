#!/usr/bin/env bash
# Thử REST API của NetBox bằng token bms-dcim: đọc được, thêm được, nhưng không xóa được
# và không xem được người dùng (quyền tối thiểu). Tạo tag "bms-demo" nếu chưa có (bộ đồng bộ sẽ dùng).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
BASE="${NETBOX_URL:-http://127.0.0.1:${NETBOX_PORT:-8001}/netbox/}"
API="${BASE%/}/api"
AUTH="Authorization: Bearer nbt_${DCIM_API_KEY}.${DCIM_API_TOKEN}"

# $1 = phương thức, $2 = đường dẫn, $3 = body JSON (tùy chọn). In "<mã HTTP> <body>".
req() {
  local out code
  out=$(mktemp)
  code=$(curl -s -o "$out" -w '%{http_code}' -X "$1" "$API$2" -H "$AUTH" -H 'Accept: application/json' \
    -H 'Content-Type: application/json' ${3:+--data "$3"})
  echo "$code $(cat "$out")"; rm -f "$out"
}
expect() { # $1 = kết quả của req, $2 = mã HTTP mong đợi, $3 = mô tả
  local code=${1%% *}
  [ "$code" = "$2" ] && echo "  OK   $3" || { echo "  LỖI $3: HTTP $code, mong đợi $2" >&2; echo "       ${1#* }" | head -c 400 >&2; echo >&2; exit 1; }
}

echo "1. Token API dùng được"
r=$(req GET /status/); expect "$r" 200 "đọc /api/status/"
python3 -c "import json,sys; v=json.loads(sys.argv[1].split(' ',1)[1])['netbox-version']; print('       NetBox', v)" "$r"

echo "2. Quyền đọc và thêm"
r=$(req GET /dcim/sites/); expect "$r" 200 "xem danh sách site"
r=$(req GET '/extras/tags/?slug=bms-demo')
if python3 -c "import json,sys; sys.exit(0 if json.loads(sys.argv[1].split(' ',1)[1])['count'] else 1)" "$r"; then
  echo "  OK   tag bms-demo đã có"
else
  r=$(req POST /extras/tags/ '{"name":"bms-demo","slug":"bms-demo","color":"0b6a65","description":"Tạo bởi bộ đồng bộ BMS · EPMS demo"}')
  expect "$r" 201 "thêm tag bms-demo"
fi
TAG_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1].split(' ',1)[1])['results'][0]['id'])" "$(req GET '/extras/tags/?slug=bms-demo')")

echo "3. Quyền tối thiểu"
r=$(req DELETE "/extras/tags/$TAG_ID/"); expect "$r" 403 "không xóa được (bộ đồng bộ không bao giờ xóa dữ liệu)"
r=$(req GET /users/users/); expect "$r" 403 "không xem được danh sách người dùng"
echo "Tất cả OK."
