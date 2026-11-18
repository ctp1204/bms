# Image -base không có mysqldump, nhưng trình cài tự động và tính năng sao lưu của iTop bắt buộc phải có.
FROM vbkunin/itop:3.2.2-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends mariadb-client \
 && rm -rf /var/lib/apt/lists/*
# Chạy sau đường hầm HTTPS: xem apache-proxy.conf
COPY apache-proxy.conf /etc/apache2/conf-available/itop-proxy.conf
RUN a2enmod headers && a2enconf itop-proxy
# Xóa file pid cũ mỗi lần container khởi động lại, nếu không Apache không lên (xem clear-apache-pid.sh)
COPY --chmod=755 clear-apache-pid.sh /etc/my_init.d/05_clear-apache-pid.sh
