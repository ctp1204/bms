#!/usr/bin/env bash
# Dựng NetBox cho bản demo: tạo dcim/.env (nếu chưa có), bật container, chờ NetBox sẵn sàng,
# rồi tạo tài khoản API bms-dcim. Chạy lại nhiều lần không sao.
set -euo pipefail
cd "$(dirname "$0")"

# Chuỗi ngẫu nhiên chỉ gồm chữ và số (token API v2 của NetBox chỉ nhận ký tự này)
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }

if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
# Sinh tự động bởi install.sh. Không commit file này.
NETBOX_PORT=8001
NETBOX_DB_PASSWORD=$(rand 32)
NETBOX_REDIS_PASSWORD=$(rand 32)
NETBOX_SECRET_KEY=$(rand 64)
NETBOX_API_TOKEN_PEPPER=$(rand 64)
NETBOX_ADMIN_PASSWORD=$(rand 20)
DCIM_USER=bms-dcim
DCIM_API_KEY=$(rand 12)
DCIM_API_TOKEN=$(rand 40)
EOF
  echo "Đã tạo dcim/.env với mật khẩu ngẫu nhiên."
fi
set -a; . ./.env; set +a
[[ "$DCIM_API_KEY" =~ ^[A-Za-z0-9]{12}$ ]] || { echo "DCIM_API_KEY phải gồm đúng 12 chữ/số." >&2; exit 1; }
[[ "$DCIM_API_TOKEN" =~ ^[A-Za-z0-9]{40,}$ ]] || { echo "DCIM_API_TOKEN phải gồm ít nhất 40 chữ/số." >&2; exit 1; }
[ ${#NETBOX_API_TOKEN_PEPPER} -ge 50 ] || { echo "NETBOX_API_TOKEN_PEPPER phải dài ít nhất 50 ký tự." >&2; exit 1; }

# Bật NetBox trước rồi tự chờ: `docker compose up -d` cả cụm sẽ đứng chờ worker (worker cần NetBox healthy).
docker compose up -d netbox
printf 'Đang chờ NetBox sẵn sàng (lần đầu chạy migration, có thể mất 5–15 phút)'
for _ in $(seq 1 200); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q netbox)" 2>/dev/null || true)
  [ "$status" = healthy ] && break
  printf '.'; sleep 5
done
echo
[ "${status:-}" = healthy ] || { echo "NetBox chưa sẵn sàng. Xem log: docker compose logs netbox" >&2; exit 1; }
docker compose up -d

echo "Tài khoản API:"
# Chạy cả file một lần (không qua shell tương tác) để lỗi Python làm script dừng
docker compose cp bootstrap.py netbox:/tmp/bms-bootstrap.py >/dev/null
docker compose exec -T -e DCIM_USER -e DCIM_API_KEY -e DCIM_API_TOKEN -e PYTHONWARNINGS=ignore netbox \
  /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py shell --no-imports -v 0 \
  -c "exec(open('/tmp/bms-bootstrap.py', encoding='utf-8').read())"

cat <<EOF
Xong. NetBox: http://127.0.0.1:${NETBOX_PORT:-8001}/
Đăng nhập: admin / NETBOX_ADMIN_PASSWORD trong dcim/.env
Kiểm tra API: ./dcim/smoke-test.sh
EOF
