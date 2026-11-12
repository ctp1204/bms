#!/usr/bin/env bash
# Cài iTop lần đầu, không cần bấm wizard. Chạy sau `docker compose up -d` trong thư mục itsm/.
# Đọc mật khẩu từ itsm/.env; file cài đặt đã điền mật khẩu chỉ tồn tại tạm trong container rồi bị xóa.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Thiếu itsm/.env. Tạo bằng: cp .env.example .env rồi đổi mật khẩu." >&2; exit 1; }
set -a; . ./.env; set +a
: "${ITOP_DB_PASSWORD:?Thiếu ITOP_DB_PASSWORD trong .env}"
: "${ITOP_ADMIN_PASSWORD:?Thiếu ITOP_ADMIN_PASSWORD trong .env}"
URL="http://127.0.0.1:${ITOP_PORT:-8000}/"

if docker compose exec -T itop test -f /var/www/html/conf/production/config-itop.php; then
  if docker compose exec -T itop test -f /var/www/html/env-production/dictionaries/languages.php; then
    echo "iTop đã được cài (có conf/production/config-itop.php). Bỏ qua."
    exit 0
  fi
  # Đã cài nhưng mất data model biên dịch (ví dụ dựng lại container khi chưa có volume itop-env):
  # chạy chế độ upgrade, dùng kết nối database trong file cấu hình hiện có, giữ nguyên dữ liệu.
  echo "iTop đã cài nhưng thiếu env-production. Biên dịch lại (upgrade, giữ dữ liệu)..."
  docker compose exec -T -u root itop sh -c 'chown -R www-data:www-data /var/www/html/env-production /var/www/html/conf && rm -rf /var/www/html/data/.maintenance'
  docker compose cp proxy-config.php itop:/tmp/proxy-config.php >/dev/null 2>&1
  # Trình cài chạy dòng lệnh không tự đoán được địa chỉ: tạm đặt địa chỉ local, xong thì trả về chế độ đường hầm.
  docker compose exec -T -u root itop php /tmp/proxy-config.php "$URL"
  docker compose exec -T -u root itop chmod 640 /var/www/html/conf/production/config-itop.php
  rc=0
  docker compose exec -T -u www-data -w /var/www/html/setup/unattended-install itop \
    php unattended-install.php --use_itop_config --param-file=xml_setup/itil-upgrade.xml --installation_xml=../../datamodels/2.x/installation.xml || rc=$?
  docker compose exec -T -u root itop php /tmp/proxy-config.php
  docker compose exec -T -u root itop sh -c 'chmod 440 /var/www/html/conf/production/config-itop.php; rm -rf /var/www/html/data/.maintenance'
  [ "$rc" = 0 ] && echo "Xong." || { echo "Biên dịch lại thất bại (mã $rc)." >&2; exit "$rc"; }
  exit 0
fi

# Thay giá trị trong mẫu. Dùng Python để mật khẩu chứa ký tự đặc biệt không làm hỏng lệnh thay thế.
python3 - "$URL" > /tmp/itop-install.$$.xml <<'PY'
import os, sys
from xml.sax.saxutils import escape
s = open('itop-install.xml', encoding='utf-8').read()
s = s.replace('__DB_PASSWORD__', escape(os.environ['ITOP_DB_PASSWORD']))
s = s.replace('__ADMIN_PASSWORD__', escape(os.environ['ITOP_ADMIN_PASSWORD']))
s = s.replace('__URL__', escape(sys.argv[1]))
sys.stdout.write(s)
PY
trap 'rm -f /tmp/itop-install.$$.xml; docker compose exec -T -u root itop rm -f /tmp/itop-install.xml >/dev/null 2>&1 || true' EXIT

docker compose cp /tmp/itop-install.$$.xml itop:/tmp/itop-install.xml
docker compose exec -T -u root itop sh -c 'chown www-data:www-data /tmp/itop-install.xml && chmod 600 /tmp/itop-install.xml && rm -rf /var/www/html/data/.maintenance'
docker compose exec -T -u www-data -w /var/www/html/setup/unattended-install itop \
  php unattended-install.php --param-file=/tmp/itop-install.xml --installation_xml=../../datamodels/2.x/installation.xml

echo "Xong. Mở ${URL} và đăng nhập bằng tài khoản admin."
