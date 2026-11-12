<?php
// Tạo dữ liệu nền trong iTop cho bộ nối cảnh báo → ticket. Chạy lại nhiều lần không tạo trùng.
// Đọc tên đối tượng từ config/itsm.json; mật khẩu tài khoản API lấy từ biến môi trường ITSM_PASSWORD.
// Chạy trong container iTop qua itsm/bootstrap.sh, không chạy trực tiếp.

require_once '/var/www/html/approot.inc.php';
require_once APPROOT.'application/application.inc.php';
require_once APPROOT.'application/startup.inc.php';

$aCfg = json_decode(file_get_contents($argv[1]), true);
$sLogin = getenv('ITSM_USER') ?: 'bms-itsm';
$sPwd = getenv('ITSM_PASSWORD');
if (!$aCfg || !$sPwd) {
	fwrite(STDERR, "Cần đường dẫn itsm.json và biến ITSM_PASSWORD\n");
	exit(1);
}
CMDBObject::SetTrackInfo('bms-itsm bootstrap');

function find(string $sClass, array $aKey): ?DBObject
{
	$aCond = [];
	foreach (array_keys($aKey) as $k) $aCond[] = "$k = :$k";
	$oSet = new DBObjectSet(DBObjectSearch::FromOQL("SELECT $sClass WHERE ".implode(' AND ', $aCond)), [], $aKey);
	return $oSet->Fetch();
}

function ensure(string $sClass, array $aKey, array $aExtra = []): DBObject
{
	$o = find($sClass, $aKey);
	if ($o) {
		echo "  có sẵn   $sClass: ".$o->GetName()."\n";
		return $o;
	}
	$o = MetaModel::NewObject($sClass);
	foreach ($aKey + $aExtra as $k => $v) $o->Set($k, $v);
	$o->DBInsert();
	echo "  đã tạo   $sClass: ".$o->GetName()."\n";
	return $o;
}

$aItop = $aCfg['itop'];
$oOrg = ensure('Organization', ['name' => $aItop['organization']]);
$iOrg = $oOrg->GetKey();

$oDm = ensure('DeliveryModel', ['name' => $aItop['deliveryModel'], 'org_id' => $iOrg]);
if ((int)$oOrg->Get('deliverymodel_id') !== (int)$oDm->GetKey()) {
	$oOrg->Set('deliverymodel_id', $oDm->GetKey());
	$oOrg->DBUpdate();
	echo "  gắn      DeliveryModel vào Organization\n";
}

foreach ($aCfg['teams'] as $sKey => $aTeam) {
	if ($sKey[0] === '$') continue;
	$oTeam = ensure('Team', ['name' => $aTeam['itop'], 'org_id' => $iOrg]);
	// Nhóm phải nằm trong delivery model thì mới gán ticket cho nhóm được
	ensure('lnkDeliveryModelToContact', ['deliverymodel_id' => $oDm->GetKey(), 'contact_id' => $oTeam->GetKey()]);
}

$oCaller = ensure('Person', ['name' => $aItop['callerLastName'], 'first_name' => $aItop['callerFirstName'], 'org_id' => $iOrg]);
ensure('Location', ['name' => $aCfg['cmdb']['location'], 'org_id' => $iOrg], ['status' => 'active']);

// Tài khoản API: mỗi tích hợp một tài khoản, chỉ có quyền tối thiểu cho việc của nó.
function ensureUser(string $sLogin, string $sPwd, int $iContact, array $aProfiles, string $sReason): void
{
	$oUser = find('UserLocal', ['login' => $sLogin]);
	$bNew = !$oUser;
	if ($bNew) {
		$oUser = MetaModel::NewObject('UserLocal');
		$oUser->Set('login', $sLogin);
		$oUser->Set('contactid', $iContact);
		$oUser->Set('language', 'EN US');
	}
	$oUser->Set('password', $sPwd); // luôn đồng bộ với itsm/.env
	$oLinks = $oUser->Get('profile_list');
	$aHave = [];
	$oLinks->Rewind();
	while ($oLnk = $oLinks->Fetch()) $aHave[] = $oLnk->Get('profile');
	foreach ($aProfiles as $sProfile) {
		if (in_array($sProfile, $aHave, true)) continue;
		$oProfile = find('URP_Profiles', ['name' => $sProfile]);
		if (!$oProfile) throw new Exception("Không thấy profile '$sProfile'");
		$oLnk = MetaModel::NewObject('URP_UserProfile');
		$oLnk->Set('profileid', $oProfile->GetKey());
		$oLnk->Set('reason', $sReason);
		$oLinks->AddItem($oLnk);
	}
	$oUser->Set('profile_list', $oLinks);
	$bNew ? $oUser->DBInsert() : $oUser->DBUpdate();
	echo ($bNew ? '  đã tạo   ' : '  cập nhật ')."UserLocal: $sLogin (".implode(', ', $aProfiles).")\n";
}

// Tạo và cập nhật ticket
ensureUser($sLogin, $sPwd, $oCaller->GetKey(), ['REST Services User', 'Service Desk Agent', 'Support Agent'], 'bms-itsm connector');
// Đồng bộ CMDB: chỉ quản lý CI, không đụng tới ticket
$sCmdbPwd = getenv('ITSM_CMDB_PASSWORD');
if ($sCmdbPwd) {
	ensureUser(getenv('ITSM_CMDB_USER') ?: 'bms-cmdb', $sCmdbPwd, $oCaller->GetKey(), ['REST Services User', 'Configuration Manager'], 'bms-itsm CMDB sync');
}
echo "Xong.\n";
