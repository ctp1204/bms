# Tạo tài khoản API bms-dcim với quyền tối thiểu và token v2 cố định lấy từ dcim/.env.
# Chạy trong container NetBox qua `manage.py shell -c` (xem install.sh). Chạy lại nhiều lần không sao.
#   Quyền: xem, thêm, sửa các đối tượng DCIM mà bộ đồng bộ cần. KHÔNG có quyền xóa,
#   không quản lý người dùng: bộ đồng bộ lỗi cũng không xóa được dữ liệu trong NetBox.
import os

from core.models import ObjectType
from users.choices import TokenVersionChoices
from users.models import ObjectPermission, Token, User

USER = os.environ['DCIM_USER']
KEY = os.environ['DCIM_API_KEY']
TOKEN = os.environ['DCIM_API_TOKEN']
PERMISSION = 'bms-dcim: đồng bộ DCIM (không xóa)'
MODELS = [
    ('dcim', 'site'), ('dcim', 'location'), ('dcim', 'rack'), ('dcim', 'rackrole'),
    ('dcim', 'manufacturer'), ('dcim', 'devicetype'), ('dcim', 'devicerole'), ('dcim', 'device'),
    ('dcim', 'powerporttemplate'), ('dcim', 'poweroutlettemplate'),
    ('dcim', 'powerport'), ('dcim', 'poweroutlet'), ('dcim', 'powerpanel'), ('dcim', 'powerfeed'),
    ('dcim', 'cable'), ('dcim', 'cabletermination'), ('extras', 'tag'),
]


def say(state, text):
    print(f'  {state:<8} {text}')


user, created = User.objects.get_or_create(username=USER, defaults={'is_active': True})
if user.has_usable_password() or not user.is_active:
    user.set_unusable_password()  # chỉ dùng token, không đăng nhập giao diện
    user.is_active = True
    user.save()
say('tạo' if created else 'có sẵn', f'người dùng {USER}')

perm, created = ObjectPermission.objects.get_or_create(name=PERMISSION, defaults={'actions': ['view', 'add', 'change']})
perm.actions = ['view', 'add', 'change']
perm.enabled = True
perm.save()
perm.object_types.set([ObjectType.objects.get_by_natural_key(app, model) for app, model in MODELS])
perm.users.add(user)
say('tạo' if created else 'cập nhật', f'quyền "{PERMISSION}" trên {len(MODELS)} loại đối tượng')

# Token cố định theo .env để bộ đồng bộ đọc được từ dcim/.env. NetBox chỉ lưu bản băm, không đổi được
# giá trị của token đã có, nên khi .env thay đổi thì xóa token cũ và tạo lại.
token = Token.objects.filter(user=user, key=KEY).first()
if token and token.validate(TOKEN):
    say('có sẵn', 'token API của bms-dcim')
else:
    Token.objects.filter(user=user).delete()
    Token.objects.create(user=user, key=KEY, token=TOKEN, version=TokenVersionChoices.V2,
                         write_enabled=True, description='bms-dcim sync (dcim/.env)')
    say('tạo', 'token API của bms-dcim (giá trị trong dcim/.env)')
