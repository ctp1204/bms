#!/usr/bin/env bash
# Mở iTop ra internet qua đường hầm HTTPS để bản demo trên Render tạo được ticket.
# iTop vẫn chạy ở máy này; tắt máy hoặc tắt đường hầm là hết ticket.
#   ./tunnel.sh        bật iTop + đường hầm, in địa chỉ cần dán vào Render
#   ./tunnel.sh url    in lại địa chỉ hiện tại
#   ./tunnel.sh down   tắt đường hầm (iTop vẫn chạy ở 127.0.0.1)
# Chọn đường hầm:
#   - ngrok nếu itsm/.env có NGROK_AUTHTOKEN: địa chỉ cố định, chỉ cần dán vào Render một lần.
#   - Cloudflare Quick Tunnel nếu không có: không cần tài khoản, nhưng địa chỉ đổi mỗi lần bật lại.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Thiếu itsm/.env (xem .env.example)." >&2; exit 1; }
set -a; . ./.env; set +a

if [ -n "${NGROK_AUTHTOKEN:-}" ]; then
  PROVIDER=ngrok; SVC=ngrok
else
  PROVIDER=cloudflare; SVC=tunnel
fi
dc() { docker compose --profile "$SVC" "$@"; }

current_url() {
  if [ "$PROVIDER" = ngrok ]; then
    dc logs "$SVC" 2>/dev/null | grep 'started tunnel' | grep -o 'url=https://[^ ]*' | sed 's/^url=//' | tail -1 || true
  else
    # Bỏ qua api.trycloudflare.com: đó là địa chỉ cloudflared gọi để xin đường hầm, có trong log khi thất bại.
    dc logs "$SVC" 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true
  fi
}
tunnel_error() {
  dc logs "$SVC" 2>/dev/null | grep -E 'lvl=(eror|crit)|ERR_NGROK|failed to request quick Tunnel|provisioning failed' | tail -1 || true
}
tunnel_running() {
  [ -n "$(dc ps -q --status running "$SVC" 2>/dev/null)" ]
}

case "${1:-up}" in
  down)
    dc stop "$SVC"
    echo "Đã tắt đường hầm ($PROVIDER). Bản trên Render sẽ báo 'iTop: lỗi, đang thử lại' cho tới khi bật lại."
    exit 0 ;;
  url)
    u=$(current_url)
    [ -n "$u" ] && tunnel_running && echo "$u/" || { echo "Đường hầm chưa chạy. Chạy ./tunnel.sh" >&2; exit 1; }
    exit 0 ;;
  up) ;;
  *) echo "Dùng: ./tunnel.sh [up|url|down]" >&2; exit 1 ;;
esac

docker compose up -d itop >/dev/null
docker compose exec -T itop test -f /var/www/html/conf/production/config-itop.php \
  || { echo "iTop chưa được cài. Chạy ./install.sh và ./bootstrap.sh trước." >&2; exit 1; }
docker compose cp proxy-config.php itop:/tmp/proxy-config.php >/dev/null 2>&1
docker compose exec -T -u root itop php /tmp/proxy-config.php

echo "Đường hầm: $PROVIDER"
dc up -d --force-recreate "$SVC" >/dev/null
printf 'Đang chờ cấp địa chỉ'
url=''
for _ in $(seq 1 30); do
  url=$(current_url)
  [ -n "$url" ] && break
  tunnel_running || break # lỗi (sai token, bị giới hạn…) thì tiến trình đường hầm tự thoát
  printf '.'; sleep 2
done
if [ -z "$url" ]; then
  echo
  err=$(tunnel_error)
  dc stop "$SVC" >/dev/null 2>&1 || true
  echo "Không lấy được địa chỉ đường hầm. ${err:+Lỗi: $err}" >&2
  case "$err" in
    *ERR_NGROK_4018*|*authtoken*|*authentication*) echo "NGROK_AUTHTOKEN trong itsm/.env sai hoặc đã bị thu hồi. Lấy lại ở https://dashboard.ngrok.com/get-started/your-authtoken" >&2 ;;
    *ERR_NGROK_108*) echo "Tài khoản ngrok miễn phí chỉ cho 1 phiên agent. Tắt ngrok đang chạy ở nơi khác rồi chạy lại." >&2 ;;
    *429*) echo "Cloudflare đang giới hạn số lần xin địa chỉ. Chờ 10–15 phút, hoặc dùng ngrok (thêm NGROK_AUTHTOKEN vào .env)." >&2 ;;
    *deadline*|*timeout*|*Timeout*|*500*) echo "Cloudflare không cấp được địa chỉ (lỗi phía Cloudflare). Thử lại sau, hoặc dùng ngrok." >&2 ;;
    *) echo "Xem log: docker compose --profile $SVC logs $SVC" >&2 ;;
  esac
  exit 1
fi
echo " $url"

# Địa chỉ mới (nhất là của Cloudflare) cần vài giây để có hiệu lực
printf 'Đang kiểm tra đường hầm'
code=''
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'ngrok-skip-browser-warning: 1' "$url/webservices/rest.php?version=1.3" || true)
  [ "$code" = "200" ] && break
  printf '.'; sleep 3
done
[ "$code" = "200" ] && echo " OK" || { echo; echo "Đường hầm chưa trả lời (HTTP $code). Thử lại sau ít phút: ./tunnel.sh url" >&2; exit 1; }

if [ "$PROVIDER" = ngrok ]; then
  note="Địa chỉ ngrok cố định: lần sau bật lại không cần sửa Render.
Lần đầu mở iTop bằng trình duyệt sẽ có trang cảnh báo của ngrok: bấm Visit Site (nhớ 7 ngày)."
else
  note="Địa chỉ Cloudflare đổi mỗi lần bật lại đường hầm: khi đó chỉ cần sửa ITSM_URL."
fi
cat <<EOF

iTop đã mở ở: $url/
Đăng nhập: admin / ITOP_ADMIN_PASSWORD trong itsm/.env

Trên Render: Dashboard → bms-demo → Environment, đặt các biến sau rồi Save (Render tự deploy lại):
  ITSM_ENABLED          1
  ITSM_URL              $url/
  ITSM_PASSWORD         (giá trị ITSM_PASSWORD trong itsm/.env)
$note
EOF
