# Профиль Б: строгий прод с БД в РФ через WireGuard (SPEC §19.4)

Этот документ — **дополнение** к `docs/DEPLOY.md`, а не замена: всё, что не описано здесь
(покупка EU-сервера, `.env`/`BotFather`/`OpenRouter`, релиз и деплой образа, `/admin`, ротация
бэкапов, восстановление), выполняется ровно как в `docs/DEPLOY.md` — код не зависит от профиля,
различие только в `.env` и compose (SPEC §19.4). Здесь описано только то, что отличается в
профиле Б: отдельный Postgres-сервер в РФ и WireGuard-туннель между ним и EU-сервером приложения.

Профиль Б применяется только по решению юриста (SPEC §19.4). Без него используется профиль А
(`docker/compose.yml`, Postgres в том же `docker compose`-стеке, `docs/DEPLOY.md`).

**Два сервера:**

- **РФ-сервер** — отдельный VPS в России, только Postgres 17. Персональные данные хранятся здесь.
- **EU-сервер** — тот же сервер приложения из `docs/DEPLOY.md` (Нидерланды/Германия). На нём
  **не остаётся постоянного хранения ПД**: только логи без текстов сообщений, имён и username
  (CLAUDE.md, SPEC §19.4), и на нём используется `docker/compose.db-remote.yml` вместо
  `docker/compose.yml`.

---

## 1. Postgres 17 на VPS в РФ

Арендовать VPS в России (провайдер по тому же принципу, что в `docs/DEPLOY.md` §1 — любой с
Ubuntu 24.04 LTS). Первичная настройка сервера — как в `docs/DEPLOY.md` §2 (пользователь `deploy`,
`ufw`, автообновления, таймзона UTC).

Установить Postgres 17 из официального APT-репозитория PGDG (не из Ubuntu — там более старая
версия):

```bash
sudo apt-get install -y curl ca-certificates gnupg
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
sudo sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'
sudo apt-get update
sudo apt-get install -y postgresql-17
```

**Локаль — обязательно UTF-8** (нужна `pg_trgm`, используемому ботом для поиска, SPEC §4): проверить
локаль кластера, созданного инсталлятором по умолчанию:

```bash
sudo -u postgres psql -c "SHOW lc_collate;"
sudo -u postgres psql -c "SHOW server_encoding;"
```

Ожидается `UTF8` и локаль вида `en_US.UTF-8`/`ru_RU.UTF-8` (не `C`/`POSIX` — иначе `pg_trgm` и
сортировка кириллицы работают некорректно). Если локаль `C`/`POSIX` — пересоздать кластер с нужной
локалью:

```bash
sudo locale-gen ru_RU.UTF-8
sudo pg_dropcluster 17 main --stop
sudo pg_createcluster 17 main --locale=ru_RU.UTF-8 --start
```

Создать роль и базу для бота (пароль — `openssl rand -hex 24`, как в `docs/DEPLOY.md` §8):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE stb WITH LOGIN PASSWORD 'ВАШ_ПАРОЛЬ';
CREATE DATABASE stb OWNER stb;
\c stb
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
```

**Ожидаемый результат:** `sudo -u postgres psql -c '\l'` показывает базу `stb` с владельцем `stb`;
`SHOW server_encoding` → `UTF8`.

**Если что-то пошло не так:**

- `pg_trgm` отказывается создаваться — проверить `SHOW server_encoding`/`SHOW lc_collate`: с локалью
  `C` расширение ставится, но даёт неверные результаты на кириллице; пересоздать кластер (выше).
- `apt-get install postgresql-17` не находит пакет — проверить, что строка PGDG-репозитория
  подставила правильный `VERSION_CODENAME` (`noble` для 24.04): `cat /etc/apt/sources.list.d/pgdg.list`.

---

## 2. TLS-сертификат Postgres

Самоподписанный сертификат достаточен: соединение и так идёт только через приватный
WireGuard-туннель (шаг 3), TLS здесь — вторая защита канала, а не публичная аутентификация домена.

```bash
sudo install -d -o postgres -g postgres -m 0700 /etc/postgresql/17/main/certs
cd /etc/postgresql/17/main/certs
sudo -u postgres openssl req -new -x509 -days 3650 -nodes \
  -text -out server.crt -keyout server.key -subj "/CN=stb-db-rf"
sudo -u postgres chmod 600 server.key
```

В `/etc/postgresql/17/main/postgresql.conf`:

```ini
ssl = on
ssl_cert_file = '/etc/postgresql/17/main/certs/server.crt'
ssl_key_file = '/etc/postgresql/17/main/certs/server.key'
# слушать только на интерфейсе WireGuard, который появится после шага 3 (например, 10.8.0.1)
listen_addresses = 'localhost,10.8.0.1'
```

**Важно про порядок загрузки после перезагрузки сервера:** Postgres должен запускаться **после**
того, как поднят интерфейс WireGuard — иначе при старте системы `listen_addresses =
'localhost,10.8.0.1'` свяжется только с `localhost` (адреса `10.8.0.1` ещё не существует), и
приложение потеряет связь с БД до следующего ручного перезапуска `postgresql`. Варианты (любой
один, не оба обязательно):

- systemd drop-in: `sudo systemctl edit postgresql` и добавить
  ```ini
  [Unit]
  After=wg-quick@wg0.service
  Wants=wg-quick@wg0.service
  ```
- либо `sudo sysctl net.ipv4.ip_nonlocal_bind=1` (разрешает слушать на ещё не поднятом адресе;
  проще, но менее явно документирует зависимость, чем drop-in выше).

В `/etc/postgresql/17/main/pg_hba.conf` добавить строку, разрешающую подключение **только** с
туннельного адреса EU-сервера (`10.8.0.2` ниже, шаг 3) и **только** с TLS (`hostssl`, не `host`):

```
hostssl  stb  stb  10.8.0.2/32  scram-sha-256
```

```bash
sudo systemctl restart postgresql
```

**Ожидаемый результат:** `sudo -u postgres psql -c "SHOW ssl;"` → `on`.

**Если что-то пошло не так:**

- `could not load server certificate file` — проверить права (`server.key` должен быть читаем
  только пользователем `postgres`, `600`) и владельца каталога `certs`.
- После перезапуска Postgres не слушает на `10.8.0.1` — интерфейс WireGuard ещё не поднят (сначала
  выполнить шаг 3, затем перезапустить `postgresql` повторно).

---

## 3. WireGuard между серверами

Установить WireGuard на обоих серверах:

```bash
sudo apt-get install -y wireguard
```

**На РФ-сервере** (Postgres, будет `10.8.0.1`):

```bash
cd /etc/wireguard
umask 077
wg genkey | tee rf-private.key | wg pubkey > rf-public.key
cat rf-private.key   # понадобится ниже
cat rf-public.key    # отдать EU-серверу
```

`/etc/wireguard/wg0.conf` на РФ-сервере:

```ini
[Interface]
Address = 10.8.0.1/24
PrivateKey = <содержимое rf-private.key>
ListenPort = 51820

[Peer]
# EU-сервер приложения
PublicKey = <публичный ключ EU-сервера, см. ниже>
AllowedIPs = 10.8.0.2/32
```

**На EU-сервере** (приложение, будет `10.8.0.2`):

```bash
cd /etc/wireguard
umask 077
wg genkey | tee eu-private.key | wg pubkey > eu-public.key
cat eu-private.key
cat eu-public.key    # отдать РФ-серверу
```

`/etc/wireguard/wg0.conf` на EU-сервере:

```ini
[Interface]
Address = 10.8.0.2/24
PrivateKey = <содержимое eu-private.key>

[Peer]
# РФ-сервер Postgres
PublicKey = <публичный ключ РФ-сервера>
Endpoint = <публичный IP РФ-сервера>:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

Поднять туннель на обоих серверах и включить автозапуск:

```bash
sudo systemctl enable --now wg-quick@wg0
```

`ufw` на РФ-сервере — разрешить WireGuard только с публичного IP EU-сервера (не открывать порт
всему интернету) и Postgres — только внутри туннеля:

```bash
sudo ufw allow from <публичный IP EU-сервера> to any port 51820 proto udp
sudo ufw allow in on wg0 to any port 5432 proto tcp
```

`ufw` на EU-сервере — разрешить исходящий WireGuard (обычно уже разрешён по умолчанию, если
`ufw` не ограничивает outgoing; если ограничивает — явно):

```bash
sudo ufw allow out 51820/udp
```

**Ожидаемый результат:**

- `sudo wg show` на обоих серверах показывает peer с ненулевым `latest handshake`.
- `ping -c3 10.8.0.1` с EU-сервера проходит.

**Если что-то пошло не так:**

- `latest handshake` отсутствует — проверить, что публичные ключи не перепутаны местами (частая
  ошибка: вставить свой публичный ключ как ключ пира), и что `ufw`/провайдерский firewall
  пропускают UDP 51820 на РФ-сервере.
- `ping` не проходит, но `wg show` видит handshake — проверить `AllowedIPs` (должен включать адрес
  именно того узла, до которого пингуете) и что `ufw` на РФ-сервере не блокирует трафик `in on wg0`
  целиком (ICMP отдельно от правила для порта 5432 выше).

---

## 4. Проверка подключения к БД через туннель

С EU-сервера (или с локальной машины, если она тоже в туннеле — обычно нет, проверка делается с
EU-сервера):

```bash
psql "host=10.8.0.1 dbname=stb user=stb sslmode=require" -c "SELECT 1;"
```

Ввести пароль роли `stb`, созданный в шаге 1.

**Ожидаемый результат:** команда выводит таблицу с одной строкой `?column?` = `1`, без ошибок TLS.

**Если что-то пошло не так:**

- `could not connect to server: Connection refused` — Postgres не слушает на `10.8.0.1`
  (`listen_addresses` в шаге 2) или `pg_hba.conf` не содержит строку с адресом EU-сервера.
- `FATAL: no pg_hba.conf entry for host ... no encryption` — проверка пришла с `sslmode=disable`
  или не через туннель; профиль Б требует `sslmode=require` именно потому, что `pg_hba.conf`
  разрешает только `hostssl`.
- `psql: error: connection to server at "10.8.0.1" ... timeout expired` — туннель не поднят
  (`sudo wg show` на обоих серверах, шаг 3) либо `ufw` на РФ-сервере блокирует порт 5432 для `wg0`.

После успешной проверки — указать этот же адрес в `.env` EU-сервера:

```
DATABASE_URL=postgres://stb:<пароль>@10.8.0.1:5432/stb?sslmode=require
```

(ср. `.env.example`: `DATABASE_URL=postgres://stb:***@db:5432/stb` в профиле А — там `db` — это
имя сервиса в `docker/compose.yml`, здесь — туннельный адрес РФ-сервера.)

**На EU-сервере в профиле Б `scripts/compose.sh`/`scripts/deploy.sh`/`scripts/backup.sh` НЕ
используются** — все три жёстко прописывают `docker/compose.yml` (`scripts/lib/common.sh`:
`COMPOSE_FILE="$ROOT_DIR/docker/compose.yml"`, без точки переопределения — в отличие от
`STB_ENV_FILE`/`STB_DEPLOY_STATE_DIR`, которые существуют только для тестов). Запустив их как
есть на профиле Б, получите попытку управлять локальным сервисом `db`, которого в
`compose.db-remote.yml` просто нет, — молча мимо несуществующей/пустой базы, без явной ошибки.
Вместо них — голые команды `docker compose` с `docker/compose.db-remote.yml` напрямую:

```bash
# деплой/обновление версии
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod pull
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod up -d

# логи приложения
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod logs -f app
```

(`stb-prod` — пример `COMPOSE_PROJECT`/`-p`; подставить реальное значение из `.env`.) Бэкапы в
профиле Б тоже не через `scripts/backup.sh` — отдельная процедура на стороне РФ-сервера
(`pg_dump` локально там), см. §5 ниже.

---

## 5. Бэкапы на стороне РФ

`scripts/backup.sh`/`restore.sh` (`docs/DEPLOY.md` §10) делают `pg_dump` через
`docker compose exec db` — в профиле Б `db` не контейнер, а нативный Postgres на РФ-сервере, так
что эти скрипты в текущем виде не подходят. Бэкап делается **на самом РФ-сервере**, тем же
принципом шифрования и ротации, что в `docs/DEPLOY.md` §10 (`age`, 14 последних копий), но без
Docker:

```bash
sudo apt-get install -y age
age-keygen -o /root/stb-backup-key.txt   # приватный ключ сразу скопировать к себе и удалить, как в DEPLOY.md §10
```

`/opt/stb-backup/backup-rf.sh` на РФ-сервере:

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/opt/stb-backup/files
AGE_RECIPIENT="age1..."   # публичный ключ, пара к /root/stb-backup-key.txt
KEEP_COUNT=14

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_FILE="$BACKUP_DIR/stb-rf-${TIMESTAMP}.sql.gz.age"

sudo -u postgres pg_dump stb | gzip | age -r "$AGE_RECIPIENT" > "$OUT_FILE"

ls -1t "$BACKUP_DIR"/stb-rf-*.sql.gz.age | tail -n "+$((KEEP_COUNT + 1))" | xargs -r rm -f
echo "Backup written: $OUT_FILE"
```

```bash
chmod +x /opt/stb-backup/backup-rf.sh
crontab -e
# добавить: 0 3 * * * /opt/stb-backup/backup-rf.sh >> /var/log/stb-rf-backup.log 2>&1
```

Доставка superadmin-у через Telegram (как в `docs/DEPLOY.md` §10's `sendDocument`) требует
`TELEGRAM_BOT_TOKEN`/`SUPERADMIN_TG_IDS` — либо добавить тот же `curl sendDocument`-вызов в
`backup-rf.sh` (значения берутся из `.env` EU-сервера, их нужно скопировать сюда отдельно — на
РФ-сервере нет `.env` приложения), либо забирать файлы с РФ-сервера `scp`-ом вручную/по расписанию.
Восстановление — обратная операция (`age -d -i /root/stb-backup-key.txt file.sql.gz.age | gunzip |
sudo -u postgres psql stb`), тестировать на отдельной базе, не на боевой, как в `docs/DEPLOY.md` §10.

**Ожидаемый результат:** `/opt/stb-backup/files` содержит не более 14 файлов, свежий файл не
пустой (`test -s`).

**Если что-то пошло не так:**

- `pg_dump: error: connection to server ... failed` — команда должна выполняться локально на
  РФ-сервере через `sudo -u postgres`, а не через сетевое подключение к `10.8.0.1`.
- Файл бэкапа пустой — проверить, что роль `postgres` имеет право читать базу `stb` (по умолчанию
  да, это суперпользователь кластера) и что диска достаточно (`df -h`).

---

## 6. Проверка отсутствия данных на EU-сервере

Профиль Б требует, чтобы на EU-сервере **не оставалось постоянного хранения ПД** (SPEC §19.4). Со
своей стороны `docker/compose.db-remote.yml` не объявляет ни одного `volumes:` и ни одного
сервиса `db` — у этого compose-проекта просто нет тома, который мог бы накопить данные БД.
Проверка на EU-сервере:

```bash
docker volume ls
```

**Ожидаемый результат:** в списке нет тома `pgdata` (и вообще никакого именованного тома этого
compose-проекта — сравните с профилем А, где `docker/compose.yml`'s `volumes: pgdata:` создаёт
том `<COMPOSE_PROJECT>_pgdata`). Если команда запущена сразу после `docker compose -f
docker/compose.db-remote.yml up -d`, список томов для этого проекта должен быть пустым.

**Если что-то пошло не так:**

- Том `pgdata` (или `<project>_pgdata`) всё же существует — EU-сервер, вероятно, когда-то
  запускался с `docker/compose.yml` (профиль А) на этом же хосте; остановить тот стек и удалить
  том осознанно (`docker compose -f docker/compose.yml down -v`, только после того как убедились,
  что данные уже перенесены на РФ-сервер) либо перейти на профиль Б на новом сервере.

---

## Что не меняется

Всё остальное — тот же процесс, что в `docs/DEPLOY.md`: выбор EU-сервера (§1), первичная настройка
(§2), BotFather и OpenRouter (§5–§6), получение кода и `.env` (§7–§8, кроме значения
`DATABASE_URL` — см. шаг 4 выше — и имени compose-файла — см. шаг 4), релиз (§8 — сборка образа в
GHCR workflow'ом не зависит от профиля). **Кроме:** обновление версии/откат (§11) и мониторинг
(§12) в `docs/DEPLOY.md` используют `scripts/deploy.sh`/`scripts/compose.sh`, которые в профиле Б
не применяются (см. шаг 4 выше) — вместо них:

```bash
# обновление версии / откат — просто другой тег на pull
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod pull
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod up -d

# мониторинг / логи
docker compose -f docker/compose.db-remote.yml --env-file .env -p stb-prod logs -f app
```

(откат деплоя здесь ручной — тот же набор команд с предыдущим тегом в `.env`/образе; `deploy.sh`'s
автоматический healthz-based rollback, запись `.deploy/current_tag` и pre-deploy backup — это всё
специфика профиля А, в профиле Б не действует.) LLM остаётся OpenRouter (с уведомлением РКН о
трансграничной передаче) или переключается на российского провайдера — отдельное решение,
не затронутое этой задачей (SPEC §19.4).
