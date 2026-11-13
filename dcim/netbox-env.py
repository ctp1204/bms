# Nạp thêm vào cấu hình NetBox (image netbox-docker tự nạp mọi file .py trong /etc/netbox/config).
# BASE_PATH: NetBox chạy dưới /netbox/ để dùng chung một địa chỉ ngrok với iTop (iTop ở /, NetBox ở /netbox/).
# Image chính thức không đọc BASE_PATH từ biến môi trường, nên đọc ở đây.
from os import environ

BASE_PATH = environ.get('BASE_PATH', '')
