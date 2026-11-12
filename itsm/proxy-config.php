<?php
// Cấu hình địa chỉ của iTop.
//   php proxy-config.php          chế độ đường hầm: để trống app_root_url và tin header X-Forwarded-*,
//                                 để iTop tự dựng địa chỉ theo request. Cùng một iTop dùng được ở
//                                 http://127.0.0.1:8000 và ở địa chỉ đường hầm mà không phải cấu hình lại.
//                                 An toàn trong demo vì cổng iTop chỉ mở ở 127.0.0.1.
//   php proxy-config.php <url>    chế độ địa chỉ cố định (trình cài iTop chạy dòng lệnh cần chế độ này).
// Chạy trong container (root) qua itsm/tunnel.sh hoặc itsm/install.sh. Chạy lại nhiều lần không sao.

// Chỉ nạp lớp Config, không khởi động cả iTop: script phải chạy được cả khi data model biên dịch đang thiếu.
require_once '/var/www/html/approot.inc.php';
require_once APPROOT.'bootstrap.inc.php';
require_once APPROOT.'core/config.class.inc.php';

$sUrl = $argv[1] ?? '';
$bProxy = $sUrl === '';
$sFile = APPCONF.'production/config-itop.php';
$oConfig = new Config($sFile);
if ($oConfig->Get('app_root_url') === $sUrl && $oConfig->Get('behind_reverse_proxy') === $bProxy) {
	echo $bProxy ? "  có sẵn   iTop đã cấu hình chạy sau đường hầm\n" : "  có sẵn   app_root_url = $sUrl\n";
	exit(0);
}
$iMode = fileperms($sFile) & 0777;
chmod($sFile, 0640); // iTop đặt file cấu hình chỉ đọc sau khi cài
$oConfig->Set('app_root_url', $sUrl);
$oConfig->Set('behind_reverse_proxy', $bProxy);
$oConfig->WriteToFile($sFile);
chmod($sFile, $iMode);
echo $bProxy
	? "  cập nhật app_root_url = '' (tự theo request), behind_reverse_proxy = true\n"
	: "  cập nhật app_root_url = $sUrl, behind_reverse_proxy = false\n";
