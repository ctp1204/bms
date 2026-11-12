# Image -base không có mysqldump, nhưng trình cài tự động và tính năng sao lưu của iTop bắt buộc phải có.
FROM vbkunin/itop:3.2.2-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends mariadb-client \
 && rm -rf /var/lib/apt/lists/*
# Chạy sau đường hầm HTTPS: xem apache-proxy.conf
COPY apache-proxy.conf /etc/apache2/conf-available/itop-proxy.conf
RUN a2enmod headers && a2enconf itop-proxy
