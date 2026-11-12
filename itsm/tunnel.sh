#!/usr/bin/env bash
# Mở iTop ra internet qua Cloudflare Quick Tunnel (miễn phí, không cần tài khoản) để bản demo
# trên Render tạo được ticket. iTop vẫn chạy ở máy này; tắt máy hoặc tắt đường hầm là hết ticket.
#   ./tunnel.sh        bật iTop + đường hầm, in địa chỉ cần dán vào Render
#   ./tunnel.sh url    in lại địa chỉ hiện tại
#   ./tunnel.sh down   tắt đường hầm (iTop vẫn chạy ở 127.0.0.1)
# Lưu ý: Quick Tunnel đổi địa chỉ mỗi lần bật lại, nên phải cập nhật ITSM_URL trên Render.
set -euo pipefail
cd "$(dirname "$0")"

current_url() {
  docker compose --profile tunnel logs tunnel 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true
}

case "${1:-up}" in
  down)
    docker compose --profile tunnel stop tunnel
    echo "Đã tắt đường hầm. Bản trên Render sẽ báo 'iTop: lỗi, đang thử lại' cho tới khi bật lại."
    exit 0 ;;
  url)
    u=$(current_url)
    [ -n "$u" ] && echo "$u/" || { echo "Đường hầm chưa chạy. Chạy ./tunnel.sh" >&2; exit 1; }
    exit 0 ;;
  up) ;;
  *) echo "Dùng: ./tunnel.sh [up|url|down]" >&2; exit 1 ;;
esac

[ -f .env ] || { echo "Thiếu itsm/.env (xem .env.example)." >&2; exit 1; }
docker compose up -d itop >/dev/null
docker compose exec -T itop test -f /var/www/html/conf/production/config-itop.php \
  || { echo "iTop chưa được cài. Chạy ./install.sh và ./bootstrap.sh trước." >&2; exit 1; }

docker compose cp proxy-config.php itop:/tmp/proxy-config.php >/dev/null 2>&1
docker compose exec -T -u root itop php /tmp/proxy-config.php

docker compose --profile tunnel up -d --force-recreate tunnel >/dev/null
printf 'Đang chờ Cloudflare cấp địa chỉ'
url=''
for _ in $(seq 1 30); do
  url=$(current_url)
  [ -n "$url" ] && break
  printf '.'; sleep 2
done
[ -n "$url" ] || { echo; echo "Không lấy được địa chỉ. Xem: docker compose --profile tunnel logs tunnel" >&2; exit 1; }
echo " $url"

# DNS của địa chỉ mới cần vài giây để có hiệu lực
printf 'Đang kiểm tra đường hầm'
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/webservices/rest.php?version=1.3" || true)
  [ "$code" = "200" ] && break
  printf '.'; sleep 3
done
[ "$code" = "200" ] && echo " OK" || { echo; echo "Đường hầm chưa trả lời (HTTP $code). Thử lại sau ít phút: ./tunnel.sh url" >&2; exit 1; }

cat <<EOF

iTop đã mở ở: $url/
Đăng nhập: admin / ITOP_ADMIN_PASSWORD trong itsm/.env

Trên Render: Dashboard → bms-demo → Environment, đặt các biến sau rồi Save (Render tự deploy lại):
  ITSM_ENABLED          1
  ITSM_URL              $url/
  ITSM_PASSWORD         (giá trị ITSM_PASSWORD trong itsm/.env)
Lần sau bật lại đường hầm, địa chỉ sẽ khác: chỉ cần sửa ITSM_URL.
EOF
