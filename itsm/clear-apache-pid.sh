#!/bin/sh
# Chạy mỗi lần container iTop khởi động (my_init chạy /etc/my_init.d/* trước khi runit bật Apache).
# Khi Docker khởi động lại container (máy/WSL khởi động lại, restart: unless-stopped), file pid của lần chạy
# trước vẫn còn. PID trong container lặp lại giống nhau mỗi lần boot, nên số pid cũ lại trùng một tiến trình
# đang sống (tail của log-forwarder): apachectl báo "httpd already running", thoát, Apache không bao giờ lên
# và đường hầm trả 502. Xóa file pid cũ để Apache khởi động bình thường.
rm -f /run/apache2/apache2.pid
