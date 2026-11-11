# BMS · EPMS Demo

Lớp giám sát hợp nhất **chỉ đọc** cho phòng máy trung tâm dữ liệu. Ứng dụng đọc thiết bị làm mát (BMS) và thiết bị điện (EPMS) qua Modbus TCP, lưu lịch sử, phát cảnh báo và hiển thị trên một dashboard web song ngữ Việt / Nhật.

Toàn bộ thiết bị là **giả lập**. Ứng dụng viết bằng Node.js thuần, **không dùng thư viện ngoài**.

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
13. [Giới hạn hiện tại](#13-giới-hạn-hiện-tại)

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

---

## 4. Cấu trúc thư mục

```
bms/
├── config/
│   ├── devices.json      # thiết bị, thanh ghi, tên vi/ja, chỉ số dẫn xuất
│   └── alarms.json       # luật cảnh báo (25 luật), nội dung vi/ja
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
│   └── index.js          # máy chủ HTTP, API, SSE, proxy /sim
├── public/
│   ├── index.html        # dashboard 3 tab
│   ├── app.js            # logic giao diện, sơ đồ phòng máy, sơ đồ một sợi, biểu đồ
│   ├── i18n.js           # từ điển giao diện vi/ja
│   └── style.css
├── scripts/start.js      # chạy bộ giả lập và ứng dụng thành 2 tiến trình
├── test/                 # test bằng node:test
├── render.yaml           # cấu hình deploy Render (Blueprint)
└── data/                 # nhật ký cảnh báo khi chạy (không commit)
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
| GET | `/api/stream` | Server-Sent Events, đẩy snapshot mỗi 2 giây |
| GET, POST | `/sim/api/faults` | Chỉ khi `SIM_PROXY=1`: chuyển tiếp tới API sự cố của bộ giả lập |

Khi bật `BASIC_AUTH_PASSWORD`, mọi đường dẫn trừ `/healthz` đều cần đăng nhập.

---

## 11. Kiểm thử

```bash
npm test         # 31 test: Modbus, bộ cảnh báo, mô hình làm mát + điện, bộ thu thập, đa ngôn ngữ, Basic Auth
npm run check    # kiểm tra cú pháp mọi file JavaScript
```

Một số test đáng chú ý:

- Modbus client **không có hàm ghi**; server từ chối lệnh ghi FC6.
- Kịch bản mất điện lưới: UPS chạy pin → máy phát nhận tải sau 10 giây → chuyển về điện lưới sau 15 giây ổn định.
- Máy phát không khởi động: pin cạn và mất tải IT.
- PDU-A mất nguồn: PDU-B gánh toàn bộ tải.
- Mọi chuỗi trong cấu hình và giao diện có đủ tiếng Việt và tiếng Nhật.

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

## 13. Giới hạn hiện tại

| Chưa có | Ghi chú |
|---|---|
| Điều khiển thiết bị | Chủ ý: lớp giám sát chỉ đọc |
| BACnet/IP, SNMP, OPC UA | Mới có Modbus TCP. BACnet/IP là việc lớn nhất để nối BMS thật |
| Lưu lịch sử lâu dài | Lịch sử chỉ trong bộ nhớ 6 giờ; nên dùng InfluxDB hoặc TimescaleDB |
| Phân quyền nhiều tài khoản | Chỉ có Basic Auth một tài khoản |
| Gửi cảnh báo ra ngoài | Chưa có email, Telegram, ticket |
| Phân tích chất lượng điện, SOE, đo đếm tính tiền | Nên mua: cần đồng hồ đo chuyên dụng |
| Báo cáo kWh theo khách hàng | Dữ liệu kWh đã có; chưa có báo cáo |
| Máy chủ dự phòng, tách mạng OT/IT | Cần khi triển khai thật |

---

Tài liệu giải thích chi tiết kèm sơ đồ tương tác, kịch bản demo và bảng thuật ngữ (song ngữ Việt/Nhật): **Bên trong BMS Demo** — https://claude.ai/artifact/RsdNUtqKDUrx5ZSVHs6QF6 (chia sẻ trong tổ chức).
