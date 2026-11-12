# Image -base không có mysqldump, nhưng trình cài tự động và tính năng sao lưu của iTop bắt buộc phải có.
FROM vbkunin/itop:3.2.2-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends mariadb-client \
 && rm -rf /var/lib/apt/lists/*
