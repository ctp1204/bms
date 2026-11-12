#!/usr/bin/env bash
# Thử REST API của iTop bằng tài khoản bms-itsm: tạo Incident, thêm ghi chú, đọc lại và kiểm tra ưu tiên.
# Ticket thử có tiêu đề bắt đầu bằng [SMOKE] để dễ nhận ra và đóng tay trong iTop.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
# Thử qua đường hầm: ITSM_URL=https://….trycloudflare.com/ ./smoke-test.sh
BASE="${ITSM_URL:-http://127.0.0.1:${ITOP_PORT:-8000}/}"
URL="${BASE%/}/webservices/rest.php?version=1.3"

call() { # $1 = json_data
  curl -sf -X POST "$URL" --data-urlencode "auth_user=${ITSM_USER:-bms-itsm}" \
    --data-urlencode "auth_pwd=$ITSM_PASSWORD" --data-urlencode "json_data=$1"
}
check() { # $1 = phản hồi, $2 = biểu thức Python trên biến r, $3 = mô tả
  python3 -c "import json,sys; r=json.loads(sys.argv[1]); assert r['code']==0, r; assert ($2), r; print('  OK  ', sys.argv[2])" "$1" "$3"
}

echo "1. Quyền truy cập REST"
r=$(call '{"operation":"list_operations"}'); check "$r" "len(r['operations'])>0" "tài khoản API dùng được REST"

echo "2. Tạo Incident P1 gán nhóm DC Power"
r=$(call '{"operation":"core/create","comment":"bms-itsm smoke test","class":"Incident","output_fields":"id,ref,priority,status,team_id_friendlyname,origin",
  "fields":{"org_id":"SELECT Organization WHERE name = \"DXAI Data Center\"",
            "caller_id":"SELECT Person WHERE name = \"Monitor\" AND first_name = \"BMS-EPMS\"",
            "team_id":"SELECT Team WHERE name = \"DC Power\"",
            "title":"[SMOKE][P1][Điện] Thử tạo ticket từ BMS · EPMS","description":"<p>Ticket thử, có thể đóng.</p><p>テスト用のチケットです。</p>",
            "impact":"2","urgency":"1","origin":"monitoring"}}')
check "$r" "list(r['objects'].values())[0]['fields']['priority']=='1'" "impact 2 + urgency 1 → priority 1"
check "$r" "list(r['objects'].values())[0]['fields']['team_id_friendlyname']=='DC Power'" "gán đúng nhóm DC Power"
KEY=$(python3 -c "import json,sys; print(list(json.loads(sys.argv[1])['objects'].values())[0]['key'])" "$r")
REF=$(python3 -c "import json,sys; print(list(json.loads(sys.argv[1])['objects'].values())[0]['fields']['ref'])" "$r")
echo "      → $REF (id $KEY)"

echo "3. Thêm ghi chú vào nhật ký"
r=$(call "{\"operation\":\"core/update\",\"comment\":\"bms-itsm smoke test\",\"class\":\"Incident\",\"key\":$KEY,\"output_fields\":\"public_log\",
  \"fields\":{\"public_log\":{\"add_item\":{\"message\":\"Phát sinh thêm: Không có nguồn sau ATS\",\"format\":\"text\"}}}}")
check "$r" "'Không có nguồn sau ATS' in str(list(r['objects'].values())[0]['fields']['public_log'])" "ghi chú nằm trong public_log"

echo "4. Đọc lại theo ref"
r=$(call "{\"operation\":\"core/get\",\"class\":\"Incident\",\"key\":\"SELECT Incident WHERE ref = '$REF'\",\"output_fields\":\"ref,status,priority\"}")
check "$r" "r['message'].startswith('Found: 1')" "tìm lại được ticket theo ref"

echo "5. Ma trận ưu tiên với impact 2"
for u in 2 3 4; do
  r=$(call "{\"operation\":\"core/create\",\"comment\":\"bms-itsm smoke test\",\"class\":\"Incident\",\"output_fields\":\"priority\",
    \"fields\":{\"org_id\":\"SELECT Organization WHERE name = \\\"DXAI Data Center\\\"\",\"caller_id\":\"SELECT Person WHERE name = \\\"Monitor\\\"\",
    \"title\":\"[SMOKE] urgency $u\",\"description\":\"smoke\",\"impact\":\"2\",\"urgency\":\"$u\",\"origin\":\"monitoring\"}}")
  check "$r" "list(r['objects'].values())[0]['fields']['priority']=='$u'" "impact 2 + urgency $u → priority $u"
done
echo "Tất cả OK. Các ticket [SMOKE] có thể đóng hoặc xóa trong iTop."
