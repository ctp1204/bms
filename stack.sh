#!/usr/bin/env bash
# Bật cùng lúc iTop (itsm/) và NetBox (dcim/), chờ cả hai trả lời được, rồi mở đường hầm cho bản trên Render.
#   ./stack.sh           bật iTop + NetBox, chờ sẵn sàng, mở đường hầm (itsm/tunnel.sh)
#   ./stack.sh --local   như trên nhưng không mở đường hầm (chỉ dùng ở 127.0.0.1)
#   ./stack.sh status    xem trạng thái hai cụm và đường hầm
#   ./stack.sh down      tắt đường hầm và dừng hai cụm (dữ liệu trong volume được giữ nguyên)
# Cần đã cài một lần: itsm (install.sh, bootstrap.sh) và dcim (install.sh). Xem README mục 13, 14.
set -euo pipefail
cd "$(dirname "$0")"

for f in itsm/.env dcim/.env; do
  [ -f "$f" ] || { echo "Thiếu $f. Cài trước: README mục 13 (itsm) và 14 (dcim)." >&2; exit 1; }
done
port() { grep -E "^$2=" "$1" | cut -d= -f2- || true; }
ITOP_PORT=$(port itsm/.env ITOP_PORT); ITOP_PORT=${ITOP_PORT:-8000}
NETBOX_PORT=$(port dcim/.env NETBOX_PORT); NETBOX_PORT=${NETBOX_PORT:-8001}
ITOP_URL="http://127.0.0.1:$ITOP_PORT/webservices/rest.php?version=1.3"
NETBOX_URL="http://127.0.0.1:$NETBOX_PORT/netbox/login/"

itsm() { (cd itsm && docker compose "$@"); }
dcim() { (cd dcim && docker compose "$@"); }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true; }

case "${1:-up}" in
  status)
    echo "iTop   $(http_code "$ITOP_URL")  (127.0.0.1:$ITOP_PORT)"
    echo "NetBox $(http_code "$NETBOX_URL")  (127.0.0.1:$NETBOX_PORT/netbox/)"
    ./itsm/tunnel.sh url 2>/dev/null || echo "Đường hầm: chưa chạy"
    exit 0 ;;
  down)
    ./itsm/tunnel.sh down >/dev/null 2>&1 || true
    itsm stop
    dcim stop
    echo "Đã dừng iTop, NetBox và đường hầm. Bật lại: ./stack.sh"
    exit 0 ;;
  up|--local) ;;
  *) echo "Dùng: ./stack.sh [--local|status|down]" >&2; exit 1 ;;
esac

# Bật hai cụm song song. NetBox trước, worker sau: `up -d` cả cụm dcim sẽ đứng chờ NetBox healthy.
# --build: image iTop có bản sửa trong Dockerfile (clear-apache-pid.sh); có cache nên gần như không tốn thời gian
itsm up -d --build db itop >/dev/null 2>&1 &
dcim up -d netbox >/dev/null 2>&1 &
wait

# Chờ bằng request HTTP thật, không chỉ "container đang chạy": container có thể Up mà Apache/NetBox chưa trả lời.
wait_http() { # tên, url, số giây tối đa
  local i code=''
  printf 'Đang chờ %s' "$1"
  for ((i = 0; i < $3; i += 3)); do
    code=$(http_code "$2")
    [ "$code" = 200 ] && { echo " OK"; return 0; }
    printf '.'; sleep 3
  done
  echo " lỗi (HTTP $code)"; return 1
}
ok=1
wait_http iTop "$ITOP_URL" 180 \
  || { ok=''; echo "  iTop không trả lời. Xem log: cd itsm && docker compose logs --tail 50 itop" >&2; }
# Lần đầu NetBox chạy migration có thể hơn 5 phút; các lần sau khoảng 1 phút
wait_http NetBox "$NETBOX_URL" 900 \
  || { ok=''; echo "  NetBox không trả lời. Xem log: cd dcim && docker compose logs --tail 50 netbox" >&2; }
[ -n "$ok" ] || exit 1
dcim up -d >/dev/null 2>&1 # netbox-worker

echo "iTop:   http://127.0.0.1:$ITOP_PORT/"
echo "NetBox: http://127.0.0.1:$NETBOX_PORT/netbox/"
[ "${1:-up}" = --local ] && exit 0

echo
exec ./itsm/tunnel.sh
