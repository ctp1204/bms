# BMS · EPMS Demo

Lớp giám sát hợp nhất **chỉ đọc** cho phòng máy trung tâm dữ liệu. Ứng dụng đọc thiết bị làm mát (BMS) và thiết bị điện (EPMS) qua Modbus TCP, lưu lịch sử, phát cảnh báo và hiển thị trên một dashboard web song ngữ Việt / Nhật.

Toàn bộ thiết bị là **giả lập**. Ứng dụng viết bằng Node.js thuần, **không dùng thư viện ngoài**.

Tùy chọn:
- nối với **iTop (ITSM)** để cảnh báo tự tạo ticket, gom theo sự cố ([mục 13](#13-itsm-với-itop-tùy-chọn));
- nối với **NetBox (DCIM)** để quản lý rack, máy chủ, chuỗi cấp điện và trả lời "còn chỗ, còn điện ở đâu" ([mục 14](#14-dcim-với-netbox-tùy-chọn)).

---

## Mục lục

1. [BMS, EPMS và vai trò của demo](#1-bms-epms-và-vai-trò-của-demo)
2. [Chạy nhanh](#2-chạy-nhanh)
3. [Kiến trúc](#3-kiến-trúc)
4. [Cấu trúc thư mục](#4-cấu-trúc-thư-mục)
5. [Thiết bị giả lập](#5-thiết-bị-giả-lập)
6. [Sự cố giả lập](#6-sự-cố-giả-lập)
7. [Cơ chế cảnh báo](#7-cơ-chế-cảnh-báo)
8. [Cấu hình](#8-cấu-hình)
9. [Biến môi trường](#9-biến-môi-trường)
10. [HTTP API](#10-http-api)
11. [Kiểm thử](#11-kiểm-thử)
12. [Deploy lên Render](#12-deploy-lên-render)
13. [ITSM với iTop (tùy chọn)](#13-itsm-với-itop-tùy-chọn)
14. [DCIM với NetBox (tùy chọn)](#14-dcim-với-netbox-tùy-chọn)
15. [Giới hạn hiện tại](#15-giới-hạn-hiện-tại)

---

## 1. BMS, EPMS và vai trò của demo

| | BMS (Building Management System) | EPMS (Electrical Power Monitoring System) |
|---|---|---|
| Câu hỏi trả lời | Server có đủ mát không? | Server có điện không, dự phòng còn không? |
| Thiết bị | Chiller, CRAH/CRAC, cảm biến nhiệt độ/độ ẩm, rò rỉ nước | Tủ điện MSB, UPS, máy phát, ATS, PDU |
| Điều khiển | Có, qua bộ điều khiển DDC/PLC | Chủ yếu giám sát; ATS, máy cắt tự xử lý bằng thiết bị riêng |

Hai hệ thống phụ thuộc lẫn nhau. Ví dụ: mất điện lưới thì UPS giữ điện cho server, nhưng CRAH và chiller dừng cho tới khi máy phát nhận tải, nên phòng máy nóng lên. Chỉ khi nhìn chung mới thấy được chuỗi nguyên nhân đó.

**Demo này là lớp giám sát hợp nhất**, không phải một BMS hay EPMS hoàn chỉnh. Nó đi theo mô hình *mua lõi điều khiển của hãng, tự xây lớp giám sát phía trên*:

- **Phần mua** (thiết bị, bộ điều khiển, logic ATS): được mô phỏng trong `sim/`.
- **Phần tự xây** (đọc dữ liệu, cảnh báo, lịch sử, dashboard): là ứng dụng trong `src/` và `public/`.
- Ứng dụng **không bao giờ gửi lệnh ghi** xuống thiết bị. Modbus client chỉ có hàm đọc, và có test khẳng định điều này.
- **ITSM** cũng theo mô hình đó: dùng nền tảng có sẵn (iTop), chỉ tự viết phần nối cảnh báo → ticket và đồng bộ thiết bị vào CMDB.

---

## 2. Chạy nhanh

Yêu cầu: **Node.js 18 trở lên**. Không cần `npm install` vì dự án không có dependency.

```bash
npm start      # chạy bộ giả lập + ứng dụng giám sát
```

Mở trình duyệt:

| Link | Màn hình |
|---|---|
| http://localhost:8080 | Tổng quan |
| http://localhost:8080/#cooling | Làm mát |
| http://localhost:8080/#power | Điện (sơ đồ một sợi, tải PDU) |
| http://localhost:8080/?lang=ja | Giao diện tiếng Nhật |

Dùng bảng **"Giả lập sự cố"** ở cuối trang để bật/tắt sự cố và xem hệ thống phản ứng.

Chạy riêng từng phần (hai terminal):

```bash
npm run sim    # bộ giả lập: Modbus :5020, API sự cố :5021
npm run bms    # ứng dụng giám sát: http://localhost:8080
```

Tăng tốc mô phỏng (ví dụ nhanh gấp 5 lần) để demo:

```bash
SIM_SPEED=5 npm start
```

Nếu báo `Cổng 5020 đang bị chiếm`, nghĩa là đang có một bản khác chạy. Tắt bản đó, hoặc đổi cổng ([mục 9](#9-biến-môi-trường)).

---

## 3. Kiến trúc

Hai tiến trình độc lập, chỉ nói chuyện qua Modbus TCP, giống thực tế nơi thiết bị và phần mềm là hai hệ thống.

```
┌──────── Tiến trình 1: bộ giả lập (sim/) ────────┐        ┌──────── Tiến trình 2: giám sát (src/) ────────┐
│                                                  │        │                                               │
│  plant.js   mô hình vật lý, tính lại mỗi 0,5 s   │        │  collector.js   đọc 16 thiết bị mỗi 2 s       │
│     │       (làm mát + điện, có liên kết)        │        │     │                                         │
│     ▼                                            │  TCP   │     ▼                                         │
│  Modbus gateway :5020  ◄──── yêu cầu ĐỌC ────────┼────────┼── modbus.js (client chỉ có hàm đọc)          │
│     (16 unit id)        ──── thanh ghi ──────────┼────────┼─►   │                                         │
│                                                  │        │     ▼  snapshot                               │
│  API sự cố :5021  ◄─── bật/tắt sự cố ───┐        │        │  history.js · alarms.js · SSE                 │
└─────────────────────────────────────────┼────────┘        │  HTTP :8080  (API + dashboard)                │
                                          │                 └──────────────────────┬────────────────────────┘
                                          └──────────── Trình duyệt (public/) ◄────┘
```

Luồng một giá trị, ví dụ nhiệt độ rack R1 = 25,3°C:

1. `plant.js` tính ra 25,3°C và lưu thành thanh ghi 16 bit: `253` (hệ số 10).
2. `collector.js` gửi lệnh đọc FC4 cho unit 21, nhận về `253`.
3. Giải mã theo `config/devices.json`: `253 ÷ 10 = 25,3`, lưu tên `rack1.temp`.
4. Tính chỉ số dẫn xuất: PUE, inlet cao nhất, tải IT, điện làm mát.
5. Snapshot đi tới lịch sử, bộ cảnh báo và SSE; trình duyệt cập nhật ngay, không cần tải lại trang.

Khi bật ITSM, bộ cảnh báo còn đẩy sự kiện sang `itsm.js`, rồi qua hàng đợi tới REST API của iTop. Hàng đợi chạy riêng, nên iTop chậm hay sập cũng không làm chậm việc đọc thiết bị và phát cảnh báo.

---

## 4. Cấu trúc thư mục

```
bms/
├── config/
│   ├── devices.json      # thiết bị, thanh ghi, tên vi/ja, chỉ số dẫn xuất
│   ├── alarms.json       # luật cảnh báo (25 luật), nội dung vi/ja
│   ├── itsm.json         # quy tắc tạo ticket: nhóm sự cố, ưu tiên, SLA, ánh xạ CMDB
│   └── dcim.json         # mô hình DCIM: rack, máy chủ mẫu, chuỗi điện A/B, ngân sách, ánh xạ NetBox
├── sim/
│   ├── plant.js          # mô hình vật lý làm mát + điện, danh sách sự cố
│   └── index.js          # Modbus gateway :5020 + API sự cố :5021
├── src/
│   ├── modbus.js         # Modbus TCP tự viết (client chỉ đọc, server cho giả lập)
│   ├── collector.js      # đọc thiết bị, giải mã (16/32 bit), tính chỉ số dẫn xuất
│   ├── alarms.js         # bộ cảnh báo: độ trễ, vùng chết, xác nhận, ẩn trùng
│   ├── history.js        # lịch sử trong bộ nhớ (6 giờ)
│   ├── locale.js         # hỗ trợ đa ngôn ngữ phía máy chủ
│   ├── auth.js           # Basic Auth cho bản deploy
│   ├── itop.js           # client REST của iTop (http/https có sẵn của Node)
│   ├── itsm.js           # bộ nối cảnh báo → ticket, hàng đợi có thử lại
│   ├── itsm-cmdb.js      # đồng bộ thiết bị và máy chủ vào CMDB của iTop
│   ├── netbox.js         # client REST của NetBox (token v2, không có hàm xóa)
│   ├── dcim-sync.js      # đồng bộ mô hình DCIM vào NetBox (không bao giờ xóa)
│   ├── dcim-capacity.js  # hồ sơ NetBox/config + số đo → dung lượng, "lắp vào đâu"
│   ├── dcim-impact.js    # mất PDU thì máy chủ nào mất điện / còn một nguồn
│   └── index.js          # máy chủ HTTP, API, SSE, proxy /sim
├── public/
│   ├── index.html        # dashboard 4 tab (Tổng quan, Làm mát, Điện, Dung lượng)
│   ├── app.js            # logic giao diện, sơ đồ phòng máy, sơ đồ một sợi, biểu đồ
│   ├── i18n.js           # từ điển giao diện vi/ja
│   └── style.css
├── scripts/
│   ├── start.js          # chạy bộ giả lập và ứng dụng thành 2 tiến trình
│   ├── itsm-cmdb-sync.js # npm run itsm:cmdb
│   └── dcim-sync.js      # npm run dcim:sync
├── itsm/                 # iTop chạy bằng Docker (chỉ ở máy local)
│   ├── docker-compose.yml, Dockerfile
│   ├── install.sh        # cài iTop tự động, không cần wizard
│   ├── bootstrap.sh/.php # tổ chức, nhóm xử lý, tài khoản API
│   ├── smoke-test.sh     # thử REST API (local hoặc qua đường hầm)
│   ├── tunnel.sh         # mở iTop (và NetBox ở /netbox/) qua đường hầm (ngrok hoặc Cloudflare) cho bản Render
│   ├── gateway/          # nginx sau đường hầm: / → iTop, /netbox/ → NetBox
│   └── .env.example      # mẫu mật khẩu; .env thật không commit
├── dcim/                 # NetBox chạy bằng Docker (chỉ ở máy local)
│   ├── docker-compose.yml
│   ├── install.sh        # tự sinh dcim/.env, bật NetBox, tạo tài khoản API bms-dcim
│   ├── bootstrap.py      # tài khoản API quyền tối thiểu (xem/thêm/sửa, không xóa)
│   ├── netbox-env.py, launch-netbox.sh # chạy NetBox dưới /netbox/ (BASE_PATH)
│   ├── smoke-test.sh     # thử REST API và kiểm tra quyền
│   └── .env.example
├── test/                 # test bằng node:test
├── render.yaml           # cấu hình deploy Render (Blueprint)
└── data/                 # nhật ký cảnh báo, trạng thái ITSM khi chạy (không commit)
```

---

## 5. Thiết bị giả lập

Tất cả nằm sau một Modbus gateway ở cổng 5020, mỗi thiết bị một unit id, đọc bằng FC4.

| Miền | Thiết bị | Unit id | Giá trị chính |
|---|---|---|---|
| Làm mát | CRAH-1, CRAH-2 | 1, 2 | Gió cấp/hồi, tốc độ quạt, trạng thái, kW |
| Làm mát | Chiller-1 | 10 | Nước lạnh cấp/hồi, trạng thái, kW, % tải |
| Làm mát | Rack R1–R6 | 21–26 | Nhiệt độ inlet, độ ẩm |
| Làm mát | Dây cảm biến rò rỉ | 30 | Có rò rỉ, vùng |
| Điện | Tủ điện tổng MSB | 41 | V, A, kW, hệ số công suất, Hz, THD, kWh (32 bit) |
| Điện | UPS-1 (250 kW) | 42 | Chế độ, % tải, kW, % pin, thời gian lưu điện |
| Điện | Máy phát GEN-1 | 43 | Trạng thái, kW, nhiên liệu, giờ chạy |
| Điện | ATS-1 | 44 | Nguồn đang cấp, tình trạng điện lưới, số lần chuyển |
| Điện | PDU-A, PDU-B (140 kW mỗi cái) | 45, 46 | Trạng thái đầu vào, tổng kW, kW từng nhánh rack |

Một số giả định của mô hình, đặt ra để demo dễ thấy:

- **CRAH chỉ có N, không có N+1:** hỏng một CRAH là phòng quá nhiệt.
- **CRAH và chiller lấy điện sau ATS, không qua UPS:** mất điện lưới thì làm mát dừng khoảng 10 giây cho tới khi máy phát nhận tải.
- **Thời gian điển hình:** máy phát khởi động 10 giây, chiller khởi động lại 30 giây, ATS chờ điện lưới ổn định 15 giây mới chuyển về, pin UPS khoảng 19 phút.
- **Tải IT** dao động 105–135 kW theo chu kỳ 10 phút.

---

## 6. Sự cố giả lập

| Nhóm | Sự cố | Hệ quả chính |
|---|---|---|
| Làm mát | CRAH-1 / CRAH-2 hỏng | Quạt dừng, phòng nóng dần |
| Làm mát | Chiller-1 trip máy nén | Nước lạnh ấm lên, CRAH mất tác dụng |
| Làm mát | Rò rỉ nước tại vùng 2 | Cảnh báo nghiêm trọng ngay |
| Làm mát | Cảm biến Rack R4 mất kết nối | Gateway trả mã lỗi 0x0B, cảnh báo mất kết nối |
| Điện | Tải IT tăng đột biến (+60 kW) | Tải PDU, UPS và nhiệt tăng |
| Điện | Mất điện lưới | UPS chạy pin → máy phát → ATS chuyển nguồn; làm mát dừng tạm thời |
| Điện | Máy phát không khởi động | Chỉ còn pin UPS; hết pin thì mất tải IT |
| Điện | UPS lỗi, chuyển bypass | Server vẫn có điện nhưng không còn được bảo vệ |
| Điện | PDU-A mất nguồn đầu vào | PDU-B gánh toàn bộ, mất dự phòng 2N |
| Điện | Sóng hài điện áp cao | THD 9%, vượt giới hạn 8% |

Bật/tắt qua dashboard, hoặc gọi thẳng API của bộ giả lập:

```bash
curl -X POST localhost:5021/api/faults -d '{"id":"utility_outage","active":true}'
```

---

## 7. Cơ chế cảnh báo

| Cơ chế | Trường cấu hình | Ý nghĩa |
|---|---|---|
| Mức độ | `severity` | `critical` (nghiêm trọng), `warning` (cảnh báo), `info` (thông tin) |
| Độ trễ | `delaySec` | Điều kiện phải kéo dài đủ lâu mới báo, chống báo giả |
| Vùng chết | `deadband` | Phải về dưới ngưỡng một khoảng mới xóa, chống bật tắt liên tục |
| Xác nhận | (nút trên giao diện) | Cảnh báo chỉ biến mất khi **đã hết và đã được xác nhận** |
| Ẩn trùng | `suppressedBy` | Ẩn cảnh báo mức thấp khi mức cao hơn trên cùng điểm đang báo |
| Mất kết nối | `type: "comm"` | Thiết bị không trả lời 6 giây thì báo; cảnh báo cũ của thiết bị được giữ nguyên |

Nhóm luật chính:

- **Làm mát:** rack > 27°C (cảnh báo) / > 32°C (nghiêm trọng) theo ASHRAE A1; độ ẩm; CRAH/chiller lỗi hoặc dừng; nước lạnh cấp > 12°C; rò rỉ nước.
- **Điện:** mất điện lưới; không có nguồn sau ATS; đang chạy máy phát; máy phát không khởi động; nhiên liệu thấp; UPS chạy pin / bypass / lưu điện < 10 phút; PDU mất nguồn; PDU > 50% (mất dự phòng 2N) / 80% / 95% định mức; THD > 8%.
- **Chung:** PUE > 1,6; mất kết nối Modbus.

Mọi sự kiện phát sinh, xác nhận và đã hết được ghi vào `data/events.jsonl`.

---

## 8. Cấu hình

### Thêm thiết bị

Thêm một mục vào `config/devices.json`, không cần sửa code:

```json
{
  "id": "rack7", "name": { "vi": "Rack R7", "ja": "ラック R7" },
  "type": "rack_sensor", "domain": "cooling", "position": 7,
  "unit": 27, "fc": 4, "start": 0, "count": 2,
  "points": [
    { "key": "temp", "name": { "vi": "Nhiệt độ inlet", "ja": "吸気温度" },
      "offset": 0, "scale": 10, "signed": true, "uom": "°C" }
  ]
}
```

| Trường | Ý nghĩa |
|---|---|
| `unit`, `fc`, `start`, `count` | Unit id, mã lệnh đọc (3 hoặc 4), ô bắt đầu, số ô đọc |
| `domain` | `cooling` hoặc `power`, quyết định thiết bị hiện ở tab nào |
| `offset` | Vị trí thanh ghi trong khối đã đọc |
| `scale` | Hệ số chia (ví dụ 10: `253` → `25,3`) |
| `signed` | Số có dấu 16 bit (nhiệt độ có thể âm) |
| `type: "u32"` | Số 32 bit không dấu, chiếm 2 thanh ghi, word cao trước (dùng cho kWh) |
| `enum` | Bảng đổi mã sang chữ, ví dụ trạng thái `0/1/2` |
| `decimals` | Số chữ số thập phân khi hiển thị |

Nếu thêm thiết bị giả lập mới, cần thêm thanh ghi tương ứng trong `sim/plant.js` (hàm `registers`).

### Thêm luật cảnh báo

Thêm vào `config/alarms.json`. Điểm đo có thể dùng `*` để áp cho nhiều thiết bị:

```json
{ "id": "rack_hot_warn", "point": "rack*.temp", "op": ">", "value": 27,
  "deadband": 0.5, "delaySec": 10, "severity": "warning",
  "message": { "vi": "{device}: nhiệt độ inlet {value}°C vượt 27°C",
               "ja": "{device}: 吸気温度 {value}°C が 27°C を超過" } }
```

Biến dùng được trong `message`: `{device}`, `{name}`, `{value}`, `{uom}`.

### Đa ngôn ngữ

- Chữ trên giao diện nằm trong `public/i18n.js`.
- Tên thiết bị, điểm đo và nội dung cảnh báo nằm trong `config/*.json`, dạng `{ "vi": "...", "ja": "..." }`.
- Test sẽ báo lỗi nếu thiếu bản dịch, hoặc nếu biến `{...}` không khớp giữa hai ngôn ngữ.

---

## 9. Biến môi trường

| Biến | Mặc định | Dùng cho |
|---|---|---|
| `HOST` | `127.0.0.1` | Địa chỉ ứng dụng giám sát lắng nghe (deploy: `0.0.0.0`) |
| `PORT` | `8080` | Cổng web của ứng dụng giám sát |
| `MODBUS_HOST`, `MODBUS_PORT` | `127.0.0.1`, `5020` | Nơi ứng dụng đọc Modbus |
| `SIM_HOST` | `127.0.0.1` | Địa chỉ bộ giả lập lắng nghe (giữ nội bộ) |
| `SIM_MODBUS_PORT` | `5020` | Cổng Modbus của bộ giả lập |
| `SIM_CONTROL_PORT` | `5021` | Cổng API sự cố của bộ giả lập |
| `SIM_SPEED` | `1` | Tốc độ mô phỏng (ví dụ `2`, `5`) |
| `SIM_PROXY` | (tắt) | `1`: ứng dụng chuyển tiếp `/sim/api/faults` sang bộ giả lập, để chạy trên một cổng duy nhất |
| `BASIC_AUTH_USER` | `demo` | Tên đăng nhập |
| `BASIC_AUTH_PASSWORD` | (trống) | Có giá trị thì bật đăng nhập; để trống thì không cần đăng nhập |
| `ITSM_ENABLED` | (tắt) | `1`: bật bộ nối cảnh báo → ticket iTop |
| `ITSM_URL` | `http://127.0.0.1:8000/` | Địa chỉ iTop |
| `ITSM_USER`, `ITSM_PASSWORD` | `bms-itsm`, (trống) | Tài khoản API tạo ticket. Thiếu mật khẩu thì ITSM tự tắt |
| `ITSM_WARNING_HOLD_SEC` | `300` (trong `itsm.json`) | Cảnh báo mức warning phải kéo dài bao lâu mới tạo ticket. Demo: `30` |
| `ITSM_NOC_URL` | `RENDER_EXTERNAL_URL` hoặc `http://127.0.0.1:<PORT>/` | Link NOC ghi trong ticket |
| `ITSM_CMDB_USER`, `ITSM_CMDB_PASSWORD` | `bms-cmdb` | Tài khoản riêng cho `npm run itsm:cmdb` |
| `DCIM_API_KEY`, `DCIM_API_TOKEN` | (trống) | Token NetBox của `bms-dcim` (trong `dcim/.env`). Có thì hồ sơ DCIM đọc từ NetBox; không có thì dùng `config/dcim.json` |
| `NETBOX_URL` / `NETBOX_PORT` | `http://127.0.0.1:8001/netbox/` | Địa chỉ NetBox (chạy dưới `/netbox/`). Trên Render: `<địa chỉ đường hầm>/netbox/` |
| `DCIM_SOURCE` | (trống) | `config`: bỏ qua NetBox dù có token |

Ví dụ chạy song song với một bản khác:

```bash
PORT=8081 SIM_MODBUS_PORT=5030 SIM_CONTROL_PORT=5031 MODBUS_PORT=5030 npm start
```

---

## 10. HTTP API

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/healthz` | Kiểm tra sống, không cần đăng nhập |
| GET | `/api/config` | Thiết bị, chỉ số dẫn xuất, luật cảnh báo, ngôn ngữ |
| GET | `/api/snapshot` | Giá trị mới nhất, trạng thái thiết bị, cảnh báo |
| GET | `/api/history?point=rack1.temp&minutes=15` | Lịch sử một điểm đo (tối đa 6 giờ) |
| GET | `/api/alarms` | Danh sách cảnh báo hiện tại |
| POST | `/api/alarms/:id/ack` | Xác nhận cảnh báo, body `{"user":"operator"}` |
| GET | `/api/events?limit=50` | Nhật ký sự kiện cảnh báo gần nhất |
| GET | `/api/itsm` | Trạng thái kết nối iTop, số lệnh chờ, ticket của từng cảnh báo (`{"enabled":false}` khi tắt) |
| GET | `/api/dcim/capacity` | Dung lượng từng rack (U, kW đo/định mức/còn lại, nhiệt inlet) và PDU sàn so với ngưỡng 2N; ghi rõ nguồn hồ sơ |
| GET | `/api/dcim/plan?type=gpu8&count=2` | "Lắp vào đâu": rack phù hợp nhất, lý do từng rack, có giữ 2N không. Hoặc `?u=8&kw=10.2&count=2` |
| GET | `/api/dcim/impact?pdu=pdua` | Mất PDU sàn: máy chủ mất điện, máy chủ còn một nguồn, tải feed còn lại |
| GET | `/api/stream` | Server-Sent Events, đẩy snapshot mỗi 2 giây |
| GET, POST | `/sim/api/faults` | Chỉ khi `SIM_PROXY=1`: chuyển tiếp tới API sự cố của bộ giả lập |

Khi bật `BASIC_AUTH_PASSWORD`, mọi đường dẫn trừ `/healthz` đều cần đăng nhập.

---

## 11. Kiểm thử

```bash
npm test         # 101 test: Modbus, bộ cảnh báo, mô hình làm mát + điện, bộ thu thập, đa ngôn ngữ, Basic Auth, ITSM, DCIM
npm run check    # kiểm tra cú pháp mọi file JavaScript
node --test --experimental-test-coverage test/   # đo độ phủ, có sẵn trong Node
```

Test ITSM và DCIM dùng iTop giả và NetBox giả (HTTP server nhỏ trong test, `test/helpers/fake-netbox.js`), nên `npm test` không cần Docker. Bản thật được thử bằng `itsm/smoke-test.sh` và `dcim/smoke-test.sh`.

Một số test đáng chú ý:

- Modbus client **không có hàm ghi**; server từ chối lệnh ghi FC6.
- Kịch bản mất điện lưới: UPS chạy pin → máy phát nhận tải sau 10 giây → chuyển về điện lưới sau 15 giây ổn định.
- Máy phát không khởi động: pin cạn và mất tải IT.
- PDU-A mất nguồn: PDU-B gánh toàn bộ tải.
- Mọi chuỗi trong cấu hình và giao diện có đủ tiếng Việt và tiếng Nhật.
- ITSM, chạy với bộ cảnh báo thật: mất điện lưới chỉ tạo **một** ticket P1; iTop mất kết nối thì thử lại và gửi đúng một lần; khởi động lại không tạo ticket trùng.
- DCIM: đồng bộ vào NetBox rồi đọc ngược ra phải khớp hoàn toàn với config; chạy lại không ghi gì; cáp cắm sai chỗ chỉ báo xung đột, không gỡ; một máy chủ thêm trong NetBox hiện ngay ở phần dung lượng; mất PDU-A ghi đúng danh sách máy chủ vào ticket.

---

## 12. Deploy lên Render

Dự án cần một tiến trình chạy liên tục (đọc Modbus mỗi 2 giây, giữ kết nối SSE), nên **không chạy được trên Vercel hay Netlify**. File `render.yaml` cấu hình sẵn một web service miễn phí trên Render:

1. Push code lên GitHub.
2. Vào https://dashboard.render.com → **New → Blueprint** → chọn repo.
3. Nhập giá trị **`BASIC_AUTH_PASSWORD`** khi được hỏi. Mật khẩu không nằm trong repo.
4. Chờ trạng thái **Live**, rồi mở `https://<tên-service>.onrender.com/?lang=ja`.

Trên Render:

- Chỉ cổng web mở ra internet; Modbus và API sự cố nằm nội bộ trong container.
- Bảng "Giả lập sự cố" đi qua `/sim` trên cùng domain (`SIM_PROXY=1`).
- Đổi mật khẩu hoặc tốc độ mô phỏng (`SIM_SPEED`) ở tab **Environment**, rồi deploy lại.

Lưu ý gói miễn phí:

- App ngủ sau 15 phút không có truy cập; lần mở đầu chờ khoảng 30–60 giây.
- Lịch sử và nhật ký reset khi app ngủ hoặc khởi động lại.
- Mọi người xem dùng chung một bộ giả lập.

---

## 13. ITSM với iTop (tùy chọn)

Cảnh báo tự tạo **Incident** trong [iTop](https://www.combodo.com/itop) (ITSM mã nguồn mở), gắn với thiết bị trong CMDB. Theo khuyến nghị "mua, không xây từ đầu": ticket, SLA, quy trình là của iTop; repo này chỉ viết phần nối. Mặc định **tắt**; bản trên Render không dùng ITSM.

### Quy tắc tạo ticket

Toàn bộ nằm trong `config/itsm.json`. Test sẽ báo lỗi nếu có luật cảnh báo chưa được ánh xạ.

- **Gom theo nhóm sự cố**, không phải một cảnh báo một ticket. Cảnh báo đầu tiên mở ticket; các cảnh báo sau trong nhóm thành ghi chú, gắn thêm thiết bị và **nâng** ưu tiên nếu nặng hơn. Ví dụ mất điện lưới: 6 cảnh báo điện thành một ticket cho đội Điện.
- **10 nhóm, 3 nhóm xử lý:** Nguồn cấp, UPS bypass, Tải PDU (mỗi PDU một ticket), Chất lượng điện → *DC Power*; CRAH (mỗi máy một ticket), Chiller, Quá nhiệt phòng, Độ ẩm, Rò rỉ nước → *DC Cooling*; Mất kết nối (mỗi thiết bị một ticket) → *DC OT Monitoring*.
- **Ưu tiên P1–P4** kèm SLA demo (phản hồi / xử lý): P1 15 phút / 4 giờ · P2 30 phút / 8 giờ · P3 4 giờ / 24 giờ · P4 1 ngày / 5 ngày. Trong iTop: impact 2 + urgency 1–4.
- **Mức warning** chỉ tạo ticket nếu còn sau 5 phút (demo: 30 giây). Nếu nhóm đã có ticket thì ghi chú ngay. **Mức info** không tạo ticket.
- **Không tự đóng, không tự hạ ưu tiên.** Khi mọi cảnh báo trong nhóm đã hết, ticket nhận ghi chú "chờ người trực kiểm tra và đóng". Cảnh báo quay lại trong 30 phút thì ghi vào ticket cũ; sau đó, hoặc nếu ticket đã bị đóng, thì mở ticket mới có tham chiếu ticket cũ.
- **Không làm chậm giám sát:** mọi lệnh gửi iTop đi qua hàng đợi lưu trong `data/itsm-state.json`. iTop lỗi thì thử lại (2 → 4 → … → 60 giây); khởi động lại ứng dụng không tạo ticket trùng.

### Cài đặt (một lần)

Cần Docker và **Node.js 20.6 trở lên** cho lệnh `npm run start:itsm` (dùng `--env-file`).

```bash
cd itsm
cp .env.example .env            # đổi cả 4 mật khẩu trong .env
docker compose up -d --build    # iTop 3.2.2 + MariaDB, chỉ mở ở 127.0.0.1:8000
./install.sh                    # cài iTop tự động (ITIL + module trung tâm dữ liệu)
./bootstrap.sh                  # tổ chức, 3 nhóm xử lý, tài khoản API bms-itsm và bms-cmdb
./smoke-test.sh                 # thử REST API (tạo vài ticket [SMOKE], có thể đóng tay)
cd ..
npm run itsm:cmdb               # đưa 16 thiết bị (và máy chủ trong rack, xem mục 14) vào CMDB; chạy lại được bất cứ lúc nào
```

Đăng nhập iTop ở http://127.0.0.1:8000 bằng `admin` với mật khẩu `ITOP_ADMIN_PASSWORD` trong `itsm/.env`. Hai tài khoản API chỉ có quyền tối thiểu: `bms-itsm` tạo và cập nhật ticket, `bms-cmdb` chỉ quản lý CI.

### Chạy

```bash
npm run start:itsm              # như npm start, nhưng đọc itsm/.env và bật ITSM
```

Trên dashboard, header có thêm trạng thái `iTop: đã kết nối` (hoặc `đang thử lại`). Cảnh báo đã có ticket hiện link `Ticket I-…`, bấm vào để mở trong iTop.

Xóa sạch iTop để làm lại từ đầu: `cd itsm && docker compose down -v`, rồi xóa `data/itsm-state.json`.

### Dùng ITSM với bản trên Render (miễn phí)

Render free không chạy được iTop (cần MariaDB và ổ đĩa lưu dữ liệu, gói free không có). Cách miễn phí: **demo vẫn ở Render, iTop chạy ở máy bạn**, mở ra internet qua một đường hầm HTTPS chạy bằng Docker.

```
Người xem ──► Demo trên Render ──REST──► https://<tên miền ngrok>/         ──► iTop trên máy bạn
                                  └────► https://<tên miền ngrok>/netbox/  ──► NetBox trên máy bạn (nếu đã cài, mục 14)
```

Gói ngrok miễn phí chỉ có **một tên miền**, nên một proxy nginx (`itsm/gateway/`) đứng sau đường hầm chia theo đường dẫn: `/` cho iTop, `/netbox/` cho NetBox. NetBox vì vậy luôn chạy dưới `/netbox/`, kể cả ở máy (http://127.0.0.1:8001/netbox/).

`./itsm/tunnel.sh` chọn đường hầm theo `itsm/.env`:

| | ngrok (khuyến nghị) | Cloudflare Quick Tunnel (dự phòng) |
|---|---|---|
| Khi nào dùng | Có `NGROK_AUTHTOKEN` trong `itsm/.env` | Không có token |
| Tài khoản | Cần tài khoản ngrok miễn phí | Không cần |
| Địa chỉ | **Cố định** (tên miền dev của tài khoản): dán vào Render một lần | Đổi mỗi lần bật lại: phải sửa `ITSM_URL` |
| Lưu ý | Lần đầu mở iTop bằng trình duyệt có trang cảnh báo của ngrok (bấm qua, nhớ 7 ngày); gói free 1 GB/tháng | Dịch vụ thử nghiệm, có lúc không cấp được địa chỉ |

Cài lần đầu:

1. Đăng ký https://dashboard.ngrok.com/signup, lấy authtoken ở https://dashboard.ngrok.com/get-started/your-authtoken, thêm vào `itsm/.env`: `NGROK_AUTHTOKEN=...`. Token là bí mật: chỉ để trong `.env`.
2. `./itsm/tunnel.sh`: cấu hình iTop chạy sau đường hầm, bật proxy và đường hầm, kiểm tra đường hầm trả lời, rồi in ra địa chỉ. Nếu có `dcim/.env`, script ghi địa chỉ công khai vào `NETBOX_PUBLIC_ORIGIN` (để đăng nhập NetBox qua HTTPS), dựng lại NetBox nếu địa chỉ đổi, kiểm tra API NetBox qua đường hầm và in thêm các biến DCIM.
3. Trên Render: **Dashboard → bms-demo → Environment**, đặt `ITSM_ENABLED=1`, `ITSM_URL=<địa chỉ vừa in>`, `ITSM_PASSWORD=<ITSM_PASSWORD trong itsm/.env>`, rồi **Save**. Render tự deploy lại. `ITSM_USER` và `ITSM_WARNING_HOLD_SEC=30` đã có trong `render.yaml`; link NOC trong ticket lấy từ `RENDER_EXTERNAL_URL` do Render tự đặt.
4. (Nếu dùng NetBox) đặt thêm `NETBOX_URL=<địa chỉ vừa in>/netbox/`, `DCIM_API_KEY` và `DCIM_API_TOKEN` (giá trị trong `dcim/.env`). Không đặt thì tab Dung lượng trên Render dùng `config/dcim.json`.
5. Mở bản Render: header hiện `iTop: sẵn sàng`; tab Dung lượng ghi "Hồ sơ: NetBox". Bật một sự cố để thấy ticket.

Những lần sau chỉ cần `./itsm/tunnel.sh` (với ngrok không phải sửa gì trên Render). Các lệnh khác: `./itsm/tunnel.sh url` (in lại địa chỉ), `./itsm/tunnel.sh down` (tắt đường hầm). Thử API qua đường hầm: `ITSM_URL=<địa chỉ> ./itsm/smoke-test.sh`.

Lưu ý:

- **Máy bạn phải bật** khi demo. iTop hoặc đường hầm tắt thì header báo `iTop: lỗi, đang thử lại`; ticket được tạo bù khi bật lại, trừ khi Render cho app ngủ trước đó (gói free không lưu `data/itsm-state.json`, hàng đợi mất theo).
- **iTop và NetBox được mở ra internet** trong lúc đường hầm chạy: giữ mật khẩu admin mạnh (NetBox: sinh ngẫu nhiên trong `dcim/.env`), tắt đường hầm khi không dùng. Token `bms-dcim` không xóa được dữ liệu.
- NetBox là một cụm Docker riêng; proxy gọi nó qua `host.docker.internal:8001` (cổng NetBox trên máy). Đã thử với Docker Desktop trên WSL2.
- iTop được cấu hình `app_root_url` trống và `behind_reverse_proxy = true` để tự dựng địa chỉ theo request; Apache trong image thêm `X-Forwarded-Port: 443` khi đường hầm không gửi (xem `itsm/apache-proxy.conf`). An toàn vì cổng iTop chỉ mở ở `127.0.0.1`.
- Nếu iTop báo lỗi 500 sau khi dựng lại container (thiếu data model biên dịch), chạy `./itsm/install.sh`: script nhận ra và biên dịch lại, giữ nguyên dữ liệu.

### Kịch bản demo 5: từ cảnh báo đến ticket

Khoảng 6 phút. Tiếp nối kịch bản 3 và 4 trong tài liệu giải thích (xem cuối trang). Chuẩn bị: iTop đang chạy, `npm run start:itsm` (nên `SIM_SPEED=2`), mở dashboard ở tab **Điện** và iTop ở một tab khác. Header hiện `iTop: sẵn sàng`.

| # | Thao tác | Người xem thấy | Lời giải thích |
|---|---|---|---|
| 1 | Bật **Mất điện lưới** | Trong vài giây: iTop có Incident **P1** "[Điện] Sự cố nguồn cấp: Mất điện lưới", nhóm *DC Power*, gắn CI ATS-1. Trên dashboard, cảnh báo hiện `Ticket I-…`; header chuyển `iTop: đã kết nối` | "Cảnh báo nghiêm trọng mở ticket ngay, gán đúng nhóm, gắn đúng thiết bị. Không ai phải gõ tay." |
| 2 | Chờ khoảng 10 giây, mở ticket trong iTop | Nhật ký ticket có "Phát sinh thêm: UPS-1 đang chạy pin", "Không có nguồn sau ATS", "CRAH dừng". Danh sách CI có thêm UPS-1, CRAH-1, CRAH-2 | "Sáu cảnh báo điện, **một** ticket. Người trực thấy cả chuỗi sự cố ở một chỗ thay vì sáu ticket rời rạc." Nếu nước lạnh hoặc nhiệt rack vượt ngưỡng quá 30 giây, đội Làm mát nhận ticket riêng: đúng, vì họ là người xử lý phần đó. |
| 3 | Chỉ vào mô tả ticket | Nhóm sự cố, nhóm xử lý, ưu tiên kèm hạn SLA, danh sách cảnh báo kèm giờ, link quay về NOC; bản tiếng Nhật ở dưới | "Ticket đủ thông tin để xử lý mà không cần hỏi lại người trực." |
| 4 | Bấm **Xác nhận** một cảnh báo trên dashboard | Ticket nhận ghi chú "Đã xác nhận trên NOC bởi operator" | "Thao tác trên NOC và ticket luôn khớp nhau." |
| 5 | Tắt **Mất điện lưới**, chờ khoảng 30 giây | Ticket nhận "Đã hết: …" cho từng cảnh báo, rồi "Tất cả cảnh báo trong nhóm đã hết. Chờ người trực kiểm tra và đóng ticket". Ticket **vẫn mở** | "Hệ thống không tự đóng ticket. Người trực kiểm tra hiện trường rồi mới đóng." |
| 6 | Bật **CRAH-1 hỏng** | Ngay lập tức: ticket **P2** "CRAH hỏng" cho nhóm *DC Cooling*. Vài phút sau rack vượt 27°C, nhưng phải **30 giây sau** mới có ticket P3 "Quá nhiệt phòng máy". Khi vượt 32°C, ticket đó được **nâng lên P1** | "Lỗi thiết bị báo ngay; vượt ngưỡng nhẹ thì chờ cho chắc chắn, tránh tạo ticket rác. Nặng lên thì tự nâng ưu tiên." |
| 7 | (Tùy chọn) `docker compose stop itop` trong `itsm/`, rồi bật **PDU-A mất nguồn** | Cảnh báo vẫn hiện bình thường. Header: `iTop: lỗi, đang thử lại (1 lệnh chờ)` | "ITSM sập không ảnh hưởng tới giám sát." |
| 8 | `docker compose start itop`, chờ khoảng 1 phút | Header về `iTop: đã kết nối`, ticket PDU-A được tạo bù | "Không mất ticket nào trong lúc iTop sập." |

Kết thúc: tắt mọi sự cố, đóng các ticket trong iTop.

**Thông điệp chốt:** một sự cố là một ticket, đúng nhóm, đúng thiết bị, đúng ưu tiên. ITSM là phần mua; giá trị tự xây nằm ở phần nối giúp ticket phản ánh đúng thực tế phòng máy.

---

## 14. DCIM với NetBox (tùy chọn)

DCIM là **hồ sơ hạ tầng vật lý**: rack, máy chủ ở U nào, cắm điện từ đâu, còn bao nhiêu chỗ và bao nhiêu điện. BMS và EPMS cho biết số đo; DCIM cho biết số đo đó thuộc về cái gì và còn dư bao nhiêu. Demo dùng [NetBox](https://netboxlabs.com/oss/netbox/) (mã nguồn mở) làm **nguồn gốc** của hồ sơ; repo chỉ viết phần nối, giống cách làm với iTop. Không có NetBox thì demo dùng `config/dcim.json` (cùng dữ liệu), nên tab **Dung lượng** vẫn chạy trên Render.

### Mô hình

Toàn bộ nằm trong `config/dcim.json`; test giữ cho mô hình khớp với bộ giả lập và luật cảnh báo.

- **6 rack 42U**, ngân sách điện **35 kW/rack**. Mức: dưới 70% bình thường, 70–90% gần đầy, trên 90% vượt ngưỡng.
- **26 máy chủ mẫu** (máy 8 GPU 10,2 kW, 4 GPU 3,2 kW, tính toán, lưu trữ, switch), xếp để **R4 gần hết điện** và **R6 gần trống**. Bộ giả lập chia 120 kW tải IT theo công suất định mức của các máy này, nên số đo trên PDU khớp hồ sơ.
- **Chuỗi điện:** tủ PDU-A / PDU-B (140 kW, ngưỡng 2N 70 kW) → mỗi rack 2 power feed 3 pha 400 V 63 A (NetBox tính 34,9 kW, khớp ngân sách) → mỗi rack 2 thanh nguồn 0U → **PSU1 cắm phía A, PSU2 cắm phía B**. Đoạn MSB → UPS → tủ PDU chỉ ghi trong mô tả tủ (NetBox không nối dây vào tủ phân phối được).
- **Chưa làm cáp mạng**; chỉ làm chuỗi điện vì gắn trực tiếp với EPMS.
- **CMDB:** NetBox là nguồn gốc của máy chủ và vị trí. `npm run itsm:cmdb` đưa máy chủ vào iTop thành CI lớp `Server`, gắn đúng rack. 16 thiết bị hạ tầng được giám sát vẫn lấy danh sách từ `devices.json` (cảnh báo gắn với mã Modbus của chúng); trong NetBox chúng có cùng mã `bms:<id>`.

### Cài đặt (một lần)

Cần Docker. Lần đầu NetBox chạy migration database, có thể mất 5–15 phút.

```bash
./dcim/install.sh        # tự sinh dcim/.env (mật khẩu ngẫu nhiên), bật NetBox ở 127.0.0.1:8001/netbox/, tạo tài khoản API bms-dcim
./dcim/smoke-test.sh     # thử API: đọc được, thêm được, KHÔNG xóa được, không xem được người dùng
npm run dcim:sync        # tạo site, phòng máy, rack, loại thiết bị, tủ PDU, feed, thiết bị, máy chủ và cáp nguồn trong NetBox
npm run itsm:cmdb        # (nếu dùng iTop) đưa máy chủ từ NetBox vào CMDB của iTop
```

Đăng nhập NetBox ở http://127.0.0.1:8001/netbox/ bằng `admin` với `NETBOX_ADMIN_PASSWORD` trong `dcim/.env`. `npm run dcim:sync` chạy lại được bất cứ lúc nào: chỉ tạo phần thiếu và sửa trường bị lệch, **không bao giờ xóa**; đối tượng trùng hoặc cáp cắm sai chỗ được báo là xung đột để người kiểm tra.

### Chạy

```bash
npm run start:dcim       # như npm start, đọc dcim/.env: hồ sơ lấy từ NetBox (làm mới mỗi phút)
npm run start:all        # đọc cả itsm/.env và dcim/.env: ITSM + DCIM
```

Chạy online cùng bản Render: `./itsm/tunnel.sh` mở cả iTop và NetBox qua một địa chỉ ngrok (NetBox ở `/netbox/`), rồi đặt `NETBOX_URL`, `DCIM_API_KEY`, `DCIM_API_TOKEN` trên Render. Xem [mục 13](#dùng-itsm-với-bản-trên-render-miễn-phí).

Tab **Dung lượng** trên dashboard:

- **Sơ đồ rack theo U**: máy chủ đúng vị trí, tô màu theo loại; trên đầu mỗi rack là nhiệt độ inlet, thanh điện "đo được / 35 kW", số U trống. Bấm tên rack để mở trong NetBox.
- **Lắp thiết bị vào đâu?**: chọn loại máy và số lượng. Hệ thống xét U trống liền nhau, công suất còn lại theo **số đo thật**, nhiệt độ inlet, và ngưỡng 2N của PDU sàn; vẽ ô "Lắp ở đây" lên sơ đồ.
- **PDU sàn và dự phòng 2N**, **bảng dung lượng theo rack**.

Khi có cảnh báo **PDU mất nguồn đầu vào** và đang bật ITSM, ticket iTop có thêm phần **Ảnh hưởng** (song ngữ): máy chủ mất điện hẳn, máy chủ chỉ còn một nguồn (gom theo rack), và tải của feed còn lại từng rack so với 34,9 kW; các máy chủ đó được gắn làm CI của ticket.

Xóa sạch NetBox để làm lại: `cd dcim && docker compose down -v`, rồi xóa `dcim/.env` nếu muốn sinh mật khẩu mới.

### Kịch bản demo 6: còn chỗ ở đâu, mất PDU thì ảnh hưởng ai

Khoảng 6 phút. Chuẩn bị: iTop và NetBox đang chạy, `npm run start:all`, mở dashboard ở tab **Dung lượng**, NetBox và iTop ở hai tab khác.

| # | Thao tác | Người xem thấy | Lời giải thích |
|---|---|---|---|
| 1 | Chỉ vào sơ đồ rack | R1 và R4 có thanh điện màu vàng; R4 còn khoảng 5 kW, R6 còn khoảng 31 kW và 37U. Góc trên ghi "Hồ sơ: NetBox" | "Đây là hồ sơ trong NetBox ghép với số đo thật của EPMS và BMS." |
| 2 | Chọn **Máy chủ 8 GPU**, số lượng 1, bấm **Tìm chỗ** | "Nên lắp vào R6"; ô **Lắp ở đây** hiện trong R6; R1 và R4 bị loại vì thiếu điện; PDU sàn sau khi lắp vẫn giữ 2N | "Trả lời bằng số đo thật, không phải đoán theo công suất ghi trên nhãn." |
| 3 | Đổi số lượng thành 2 | R6 vẫn đủ chỗ và điện, nhưng khung vàng: PDU sàn vượt 70 kW, **mất 2N** | "Rack còn chỗ chưa chắc lắp được. DCIM nhìn cả chuỗi điện phía trên." |
| 4 | Bật **PDU-A mất nguồn** trong bảng giả lập | Tab Dung lượng: PDU-A đỏ "mất nguồn đầu vào". iTop: ticket **P2** cho *DC Power*, phần **Ảnh hưởng** liệt kê 26 máy chủ chỉ còn một nguồn, feed R4-B gánh 31,2 kW (89%); tab CIs có 26 máy chủ | "Người trực biết ngay máy nào đang chạy không dự phòng và feed nào sắp đầy, không cần tra bản vẽ." |
| 5 | (Tùy chọn) Trong NetBox, xóa cáp PSU2 của **R6-CMP-1**, chờ 1 phút, tắt rồi bật lại **PDU-A mất nguồn** | Ghi chú mới trên ticket: "MẤT ĐIỆN HẲN: 1 máy chủ: R6: R6-CMP-1" | "Máy chỉ cắm một nguồn sẽ chết khi mất PDU đó. Hồ sơ đúng thì cảnh báo đúng." Sau đó chạy `npm run dcim:sync` để nối lại cáp. |
| 6 | (Tùy chọn) Trong NetBox, thêm một máy chủ 8 GPU vào R6, chờ 1 phút | Sơ đồ R6 có máy mới; R6 còn ít U và ít kW hơn | "NetBox là nguồn gốc: sửa ở đó, mọi nơi khác theo." |

Kết thúc: tắt sự cố, đóng ticket trong iTop.

**Thông điệp chốt:** BMS và EPMS cho biết số đo; DCIM cho biết số đo đó thuộc về đâu và còn dư bao nhiêu. Hồ sơ là phần dùng sẵn (NetBox); giá trị tự xây là ghép hồ sơ với số đo thật và đưa kết quả vào đúng ticket.

---

## 15. Giới hạn hiện tại

| Chưa có | Ghi chú |
|---|---|
| Điều khiển thiết bị | Chủ ý: lớp giám sát chỉ đọc |
| BACnet/IP, SNMP, OPC UA | Mới có Modbus TCP. BACnet/IP là việc lớn nhất để nối BMS thật |
| Lưu lịch sử lâu dài | Lịch sử chỉ trong bộ nhớ 6 giờ; nên dùng InfluxDB hoặc TimescaleDB |
| Phân quyền nhiều tài khoản | Chỉ có Basic Auth một tài khoản |
| Gửi cảnh báo ra ngoài | Đã có ticket iTop (tùy chọn); chưa có email, Telegram |
| SLA thật trong iTop | Hạn SLA mới ghi trong nội dung ticket; chưa cấu hình hợp đồng, dịch vụ, SLA/SLT trong iTop |
| Lớp CI cho thiết bị làm mát | iTop không có sẵn; CRAH, chiller, dây rò rỉ tạm dùng `Peripheral`. Làm đúng cần viết extension iTop |
| ITSM trên Render | Gói miễn phí không chạy được iTop + MariaDB. Bản Render dùng iTop ở máy riêng qua đường hầm; máy đó phải bật khi demo |
| NetBox trên Render | Đọc được NetBox thật qua đường hầm chung với iTop (máy chạy NetBox phải bật); không đặt biến DCIM thì dùng `config/dcim.json` |
| Cáp mạng, cổng switch trong DCIM | Mới làm chuỗi điện |
| Đoạn MSB → UPS → tủ PDU trong NetBox | Chỉ ghi trong mô tả; NetBox không nối dây vào tủ phân phối |
| 16 thiết bị hạ tầng lấy từ NetBox | Vẫn lấy từ `devices.json` vì cảnh báo gắn với mã Modbus; máy chủ và vị trí đã lấy từ NetBox |
| Phân tích chất lượng điện, SOE, đo đếm tính tiền | Nên mua: cần đồng hồ đo chuyên dụng |
| Báo cáo kWh theo khách hàng | Dữ liệu kWh đã có; chưa có báo cáo |
| Máy chủ dự phòng, tách mạng OT/IT | Cần khi triển khai thật |

---

Tài liệu giải thích chi tiết kèm sơ đồ tương tác, kịch bản demo 1–6 (Phần A · BMS, B · EPMS, C · ITSM, D · DCIM) và bảng thuật ngữ (song ngữ Việt/Nhật): **Bên trong BMS · EPMS Demo** — https://claude.ai/artifact/RsdNUtqKDUrx5ZSVHs6QF6 (chia sẻ trong tổ chức).
