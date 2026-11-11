# BMS và EPMS

BMS và EPMS là hai hệ thống vận hành cốt lõi của trung tâm dữ liệu. Nói ngắn gọn:
- **BMS** lo phần **nhiệt và môi trường**: giữ cho server đủ mát.
- **EPMS** lo phần **điện**: giữ cho server luôn có điện và biết điện đang được dùng ra sao.

Phần dưới đi lần lượt từng hệ thống, rồi so sánh và cho thấy cách hai hệ thống liên quan với nhau.

---

## 1. BMS (Building Management System, hệ thống quản lý tòa nhà)

### Nhiệm vụ
Server biến gần như toàn bộ điện năng thành nhiệt. Một phòng máy 120 kW sinh nhiệt tương đương 120 lò sưởi điện chạy liên tục. Nếu không lấy nhiệt ra, chỉ vài phút là nhiệt độ vượt ngưỡng an toàn và server tự tắt hoặc hỏng. BMS **giám sát và điều khiển** hệ thống làm mát và môi trường để việc đó không xảy ra.

### Thiết bị BMS quản lý

| Nhóm | Thiết bị | Vai trò |
|---|---|---|
| Làm mát chính | **Chiller**, tháp giải nhiệt, bơm nước | Tạo nước lạnh (khoảng 7°C) và thải nhiệt ra ngoài trời |
| Làm mát trong phòng | **CRAH** (dùng nước lạnh), **CRAC** (có máy nén riêng) | Thổi gió lạnh vào phòng máy |
| Môi trường | Cảm biến nhiệt độ, độ ẩm ở mặt hút gió rack | Đo đúng thứ server "hít" vào |
| An toàn | Dây cảm biến rò rỉ nước dưới sàn nâng | Phát hiện nước rò từ đường ống làm mát |
| Khác | Chiếu sáng, quạt hút, van | Ít quan trọng hơn trong trung tâm dữ liệu |

### Cấu trúc 4 lớp

```
4. Phần mềm giám sát (SCADA/HMI)    màn hình, cảnh báo, lịch sử, báo cáo
          ▲  BACnet/IP · Modbus TCP
3. Mạng giao thức
          ▲
2. Bộ điều khiển DDC/PLC            ← "bộ não": nóng thì tăng quạt, mở van
          ▲
1. Cảm biến và thiết bị              đầu dò nhiệt, CRAH, chiller, van, biến tần
```

**Lớp 2 là phần quan trọng nhất.** Bộ điều khiển chạy logic tại chỗ và vẫn giữ làm mát kể cả khi phần mềm hay mạng gặp sự cố. Đây là lý do tài liệu đánh giá khuyến nghị **mua** phần này, không tự xây.

### Các chỉ số và cảnh báo điển hình
- **Nhiệt độ inlet rack** (quan trọng nhất). ASHRAE khuyến nghị 18–27°C; lớp A1 cho phép tới 32°C.
- **Độ ẩm:** quá cao gây ngưng tụ, quá thấp gây tĩnh điện.
- **Nhiệt độ nước lạnh cấp/hồi:** nước cấp ấm lên nghĩa là chiller có vấn đề.
- **Trạng thái và tốc độ quạt CRAH, tải chiller.**
- **Rò rỉ nước:** luôn ở mức nghiêm trọng.

### Ai dùng
Kỹ sư cơ điện (cài đặt, chỉnh setpoint, bảo trì) và người trực NOC (theo dõi, xử lý cảnh báo).

---

## 2. EPMS (Electrical Power Monitoring System, hệ thống giám sát điện năng)

### Nhiệm vụ
Server không được mất điện, dù chỉ một phần giây. Trung tâm dữ liệu vì vậy có nhiều lớp dự phòng điện. EPMS **giám sát toàn bộ chuỗi cấp điện** để biết:
- điện có đang tới đúng nơi không;
- các lớp dự phòng còn hoạt động không;
- đang dùng bao nhiêu điện, ở đâu;
- chất lượng điện có tốt không.

### Chuỗi cấp điện EPMS theo dõi

```
Điện lưới ──┐
            ├─► ATS ─► Tủ tổng MSB ─┬─► UPS ─┬─► PDU-A ─┐
Máy phát ───┘                       │        └─► PDU-B ─┴─► Rack (nguồn kép)
                                    └─► Tải cơ điện (chiller, CRAH, bơm)
```

| Thiết bị | Vai trò | EPMS đọc gì |
|---|---|---|
| **Tủ trung thế, hạ thế, MSB** | Nhận và chia điện | Điện áp, dòng, kW, kWh, hệ số công suất, tần số |
| **Máy phát** | Cấp điện khi mất lưới, cần khoảng 10 giây để nhận tải | Trạng thái, công suất, nhiên liệu, giờ chạy |
| **ATS / STS** | Tự chuyển giữa điện lưới và máy phát | Đang dùng nguồn nào, số lần chuyển |
| **UPS** | Dùng pin giữ điện trong lúc chờ máy phát | Chế độ (online / chạy pin / bypass), % tải, % pin, thời gian lưu điện |
| **PDU** | Chia điện tới từng rack | kW, kWh theo nhánh, % so với định mức |
| **Máy cắt (aptomat), relay** | Bảo vệ khi quá tải, chập | Trạng thái đóng/cắt, trip |

### Khái niệm then chốt: dự phòng

- **2N:** hai hệ thống độc lập (A và B), mỗi cái gánh được 100% tải. Mỗi rack cắm vào cả hai.
- **N+1:** dư một thiết bị so với nhu cầu.
- **Quy tắc vàng của 2N:** mỗi nhánh không được chạy quá 50% định mức. Nếu cả hai nhánh đều trên 50%, khi mất một nhánh thì nhánh kia sẽ quá tải. Lúc đó hệ thống **vẫn chạy nhưng dự phòng đã mất**. Đây là thứ EPMS phải phát hiện, như Kịch bản 4 trong demo.

### Phần "sâu" của EPMS
Đây là chỗ EPMS khác biệt hẳn với BMS:
- **Chất lượng điện năng:** sóng hài (THD), sụt áp, quá áp, quá độ. Cần đồng hồ chuyên dụng lấy mẫu dạng sóng hàng nghìn lần mỗi giây.
- **Ghi chuỗi sự kiện (SOE):** đóng dấu thời gian chính xác tới mili-giây để biết máy cắt nào trip trước khi có sự cố.
- **Đo đếm tính tiền:** đồng hồ đạt cấp chính xác thương mại, để tính tiền điện cho khách hàng colocation.

Những tính năng này **nằm trong phần cứng đo**, nên EPMS chỉ tự xây được khoảng 60–70% phần mềm. Phần còn lại phải mua.

### Các chỉ số và cảnh báo điển hình
- Mất điện lưới, ATS chuyển nguồn, máy phát không khởi động.
- UPS chạy pin, thời gian lưu điện thấp, UPS chuyển bypass (vẫn có điện nhưng không còn được bảo vệ).
- PDU vượt 50% (mất dự phòng 2N), 80%, 95% định mức.
- THD vượt giới hạn.
- **PUE** = tổng điện cơ sở ÷ điện IT. Chỉ số hiệu quả năng lượng, càng gần 1 càng tốt.

### Ai dùng
Kỹ sư điện, người trực NOC, và bộ phận kinh doanh (báo cáo điện năng, tính tiền khách hàng).

---

## 3. So sánh BMS và EPMS

| Tiêu chí | BMS | EPMS |
|---|---|---|
| Câu hỏi trả lời | "Server có đủ mát không?" | "Server có điện không, dự phòng còn không?" |
| Miền | Cơ (nhiệt, nước, gió) | Điện |
| Có điều khiển không | **Có**: điều khiển quạt, van, chiller qua DDC/PLC | **Chủ yếu giám sát**. Điều khiển (ATS, máy cắt) do relay và bộ điều khiển riêng tự làm |
| Tốc độ thay đổi | Chậm: nhiệt độ thay đổi trong vài phút | Rất nhanh: sự cố điện xảy ra trong mili-giây |
| Giao thức phổ biến | BACnet/IP, Modbus | Modbus, SNMP (UPS, PDU), IEC 61850 (trạm điện) |
| Phần phải mua | Bộ điều khiển và logic điều khiển | Đồng hồ chất lượng điện, SOE, đo đếm tính tiền |
| Phần tự xây được | Dashboard, cảnh báo, báo cáo (lớp chỉ đọc) | Dashboard, PUE, báo cáo kWh theo khách hàng, cảnh báo vận hành |
| Khả năng tự xây (theo tài liệu) | Thấp, rủi ro rất cao | Trung bình – thấp, rủi ro cao |

---

## 4. Vì sao phải nhìn BMS và EPMS cùng nhau

Hai hệ thống phụ thuộc lẫn nhau:

- **Điện ảnh hưởng nhiệt:** chiller và CRAH cần điện. Khi mất điện lưới, UPS thường chỉ giữ điện cho server, còn làm mát phải chờ máy phát. Trong khoảng trống đó, server vẫn sinh nhiệt mà không có gì làm mát. Sau khi có điện lại, chiller còn cần thêm thời gian để khởi động lại máy nén.
- **Nhiệt ảnh hưởng điện:** làm mát chiếm phần lớn điện "ngoài IT", quyết định PUE. Khách hàng thêm tải IT thì vừa tăng điện vừa tăng nhiệt.
- **Khi có sự cố**, nếu BMS và EPMS là hai màn hình riêng, người trực phải tự ghép hai danh sách cảnh báo để tìm nguyên nhân gốc. Một màn hình hợp nhất cho thấy ngay chuỗi "mất điện lưới → CRAH dừng → rack quá nhiệt".

Đây là lý do tài liệu đánh giá chọn mô hình: **mua BMS và EPMS riêng của hãng, tự xây lớp giám sát hợp nhất phía trên**.

---

## 5. Áp vào BMS · EPMS Demo

| Thành phần | Trong demo |
|---|---|
| Phần BMS | CRAH-1/2, Chiller-1, 6 cảm biến rack, dây rò rỉ. Tab **Làm mát** |
| Phần EPMS | Tủ MSB, UPS-1, máy phát GEN-1, ATS-1, PDU-A/B. Tab **Điện** |
| Lớp điều khiển (phần nên mua) | Bộ PI và logic ATS nằm **trong bộ giả lập**, đóng vai thiết bị của hãng |
| Lớp tự xây | Ứng dụng đọc Modbus **chỉ đọc**, cảnh báo, lịch sử, dashboard hợp nhất 3 tab |
| Chưa làm (nên mua hoặc làm sau) | Phân tích chất lượng điện, SOE, đo đếm tính tiền, BACnet/IP, SNMP |

Tóm lại, demo này không phải "một BMS tự xây" hay "một EPMS tự xây". Nó là **lớp giám sát hợp nhất** đọc dữ liệu từ cả hai, đúng phần mà tài liệu đánh giá khuyến nghị nên tự xây.
