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

$aTeams = [];
foreach ($aCfg['teams'] as $sKey => $aTeam) {
	if ($sKey[0] === '$') continue;
	$oTeam = ensure('Team', ['name' => $aTeam['itop'], 'org_id' => $iOrg]);
	// Nhóm phải nằm trong delivery model thì mới gán ticket cho nhóm được
	ensure('lnkDeliveryModelToContact', ['deliverymodel_id' => $oDm->GetKey(), 'contact_id' => $oTeam->GetKey()]);
	$aTeams[] = [$oTeam, $aTeam['vi']];
}

// Để người trực xử lý được ticket trong iTop:
// - Assign bắt buộc chọn người trong nhóm: dùng người liên hệ của tài khoản admin, đổi tên thành NOC Operator
//   (trình cài iTop tạo sẵn với tên "My first name My last name"), cho vào cả 3 nhóm.
$oAdmin = find('UserLocal', ['login' => 'admin']);
if ($oAdmin && $oAdmin->Get('contactid')) {
	$oOp = MetaModel::GetObject('Person', $oAdmin->Get('contactid'));
	if ($oOp->Get('name') !== $aItop['operatorLastName'] || $oOp->Get('first_name') !== $aItop['operatorFirstName']) {
		$oOp->Set('first_name', $aItop['operatorFirstName']);
		$oOp->Set('name', $aItop['operatorLastName']);
		$oOp->Set('org_id', $iOrg);
		$oOp->DBUpdate();
		echo "  cập nhật Person: ".$oOp->GetName()." (người liên hệ của admin)\n";
	}
	foreach ($aTeams as [$oTeam]) ensure('lnkPersonToTeam', ['team_id' => $oTeam->GetKey(), 'person_id' => $oOp->GetKey()]);
}
// - Mark as resolved bắt buộc chọn Service, và iTop chỉ cho chọn Service có hợp đồng với tổ chức của ticket.
$oService = ensure('Service', ['name' => $aItop['service'], 'org_id' => $iOrg], ['status' => 'production']);
foreach ($aTeams as [, $sName]) {
	ensure('ServiceSubcategory', ['name' => $sName, 'service_id' => $oService->GetKey()], ['request_type' => 'incident', 'status' => 'production']);
}
$oContract = ensure('CustomerContract', ['name' => $aItop['contract'], 'org_id' => $iOrg], ['provider_id' => $iOrg, 'status' => 'production']);
ensure('lnkCustomerContractToService', ['customercontract_id' => $oContract->GetKey(), 'service_id' => $oService->GetKey()]);

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
