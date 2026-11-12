<?php
// Cho iTop chạy sau đường hầm HTTPS: để trống app_root_url và tin header X-Forwarded-*,
// để iTop tự dựng địa chỉ theo request. Nhờ vậy cùng một iTop dùng được ở http://127.0.0.1:8000
// và ở địa chỉ đường hầm (đổi mỗi lần chạy) mà không phải cấu hình lại.
// An toàn trong demo vì cổng iTop chỉ mở ở 127.0.0.1: ngoài máy này chỉ đường hầm tới được.
// Chạy trong container (root) qua itsm/tunnel.sh. Chạy lại nhiều lần không sao.

require_once '/var/www/html/approot.inc.php';
require_once APPROOT.'application/application.inc.php';
require_once APPROOT.'application/startup.inc.php';

$sFile = APPCONF.'production/'.ITOP_CONFIG_FILE;
$oConfig = new Config($sFile);
if ($oConfig->Get('app_root_url') === '' && $oConfig->Get('behind_reverse_proxy') === true) {
	echo "  có sẵn   iTop đã cấu hình chạy sau đường hầm\n";
	exit(0);
}
$iMode = fileperms($sFile) & 0777;
chmod($sFile, 0640); // iTop đặt file cấu hình chỉ đọc sau khi cài
$oConfig->Set('app_root_url', '');
$oConfig->Set('behind_reverse_proxy', true);
$oConfig->WriteToFile($sFile);
chmod($sFile, $iMode);
echo "  cập nhật app_root_url = '' (tự theo request), behind_reverse_proxy = true\n";
