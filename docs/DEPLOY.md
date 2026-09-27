# Развёртывание school-task-bot на VPS

Пошаговая инструкция для разворачивания dev- и prod-окружений на одном VPS (SPEC §17.1, §27).
Оба окружения — независимые compose-проекты (`stb-dev`, `stb-prod`) в каталогах `/opt/stb-dev` и
`/opt/stb-prod` соответственно. Все команды ниже даны для `dev`; для `prod` замените `stb-dev` на
`stb-prod` и соответствующие пути/токены.

Разделы соответствуют пунктам SPEC §27. У каждого шага — точные команды, ожидаемый результат и
раздел «Если что-то пошло не так».

---

## 1. Выбор и покупка VPS

Требования: Нидерланды или Германия · минимум 2 vCPU / 2 ГБ RAM / 30 ГБ NVMe · Ubuntu 24.04 LTS ·
выделенный IPv4. Приоритет — провайдеры с оплатой российской картой/СБП; запасной вариант с
иностранной картой — Hetzner Cloud.

**Ориентировочные тарифы (проверено веб-поиском 2026-09-27; поиск по российским провайдерам
вернул мало конкретики, поэтому цифры по Aéza/FirstByte/HostVDS/Fornex — приблизительные, по общим
знаниям о рынке на начало 2026 года; Hetzner подтверждён поиском на дату проверки). **Перед
покупкой обязательно сверьте тарифы на сайте провайдера** — они меняются чаще, чем эта инструкция.

| Провайдер                        | Оплата                          | Ориентировочный тариф под требования (2 vCPU / 2+ ГБ / NVMe) | Локация                          |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Aéza                             | карта РФ, СБП, крипто           | ≈ 400–700 ₽/мес                                              | есть тарифы в NL/DE              |
| FirstByte                        | карта РФ, СБП                   | ≈ 350–650 ₽/мес                                              | есть тарифы в NL/DE              |
| HostVDS                          | карта РФ, СБП                   | ≈ 400–700 ₽/мес                                              | есть тарифы в NL/DE              |
| Fornex                           | карта РФ и иностранная          | ≈ €4–7/мес                                                   | NL                               |
| Hetzner Cloud (запасной вариант) | только иностранная карта/PayPal | CX22 (2 vCPU / 4 ГБ / 40 ГБ NVMe) ≈ €3.79–4.5/мес            | Германия (Falkenstein, Nürnberg) |

Порядок действий:

1. Выбрать провайдера и локацию (NL или DE), тариф ≥ 2 vCPU / 2 ГБ / 30 ГБ NVMe.
2. Указать ОС **Ubuntu 24.04 LTS**, включить выделенный IPv4.
3. Оплатить, дождаться письма/панели с root-доступом (обычно root-пароль или SSH-ключ).
4. Записать IP-адрес сервера — он понадобится на следующих шагах.

**Ожидаемый результат:** есть IP-адрес сервера, root-доступ по SSH подтверждён:

```bash
ssh root@<IP>
```

выводит приглашение shell на Ubuntu 24.04.

**Если что-то пошло не так:**

- SSH виснет/недоступен сразу после покупки — подождите 2–5 минут, серверы иногда ещё
  инициализируются; проверьте статус в панели провайдера.
- `Permission denied (publickey)` — панель провайдера могла выдать доступ только по паролю;
  проверьте способ входа в разделе «Доступ»/«Credentials» панели.
- Провайдер не предлагает Ubuntu 24.04 — берите ближайший доступный 24.04-образ (не 22.04): версия
  влияет на пакет `docker-ce` из шага 4.

---

## 2. Первичная настройка сервера

Выполняется от `root` при первом входе.

```bash
# обновить систему
apt update && apt upgrade -y

# часовой пояс сервера — UTC (бизнес-логика бота и так работает в UTC)
timedatectl set-timezone UTC

# создать пользователя deploy, дать ему sudo
adduser deploy
usermod -aG sudo deploy

# скопировать ваш публичный SSH-ключ пользователю deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# 2 ГБ swap (полезно на 2 ГБ RAM при сборке/пиках)
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# автоматические security-обновления
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# ufw: разрешить SSH, включить (80/443 откроем в фазе 5)
ufw allow OpenSSH
ufw enable
```

Затем в **новом терминале** (не закрывая текущую root-сессию) проверить вход под `deploy`:

```bash
ssh deploy@<IP>
```

После успешной проверки — запретить парольный вход и вход под root:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**Ожидаемый результат:**

- `ssh deploy@<IP>` пускает без пароля (по ключу), `sudo whoami` → `root`.
- `ssh root@<IP>` после отключения `PermitRootLogin` — `Permission denied`.
- `timedatectl` показывает `Time zone: UTC (UTC, +0000)`.
- `sudo ufw status` показывает `22/tcp ALLOW`.
- `free -h` показывает строку `Swap: 2.0Gi`.

**Если что-то пошло не так:**

- После `PermitRootLogin no` пропал доступ вообще — не закрывайте старую root-сессию, пока не
  проверили вход `deploy` в отдельном окне; если доступ всё же потерян, используйте web-консоль
  провайдера (VNC/serial console в панели) под root, чтобы откатить `sshd_config`.
- `ufw enable` разорвал текущую SSH-сессию — на большинстве провайдеров `ufw allow OpenSSH`
  выполняется до `enable`, поэтому SSH должен остаться доступен; если сессия оборвалась — зайдите
  через web-консоль и проверьте `ufw status numbered`.
- `swapon` пишет `swapfile has holes` — используйте `fallocate` (уже в команде выше), не `dd` с
  `seek`, либо на файловых системах без поддержки `fallocate` замените на
  `dd if=/dev/zero of=/swapfile bs=1M count=2048`.

---

## 3. Проверка доступности Telegram и OpenRouter

```bash
curl -sS https://api.telegram.org
curl -sS https://openrouter.ai/api/v1/models | head
```

**Ожидаемый результат:**

- Первая команда — JSON вида `{"ok":false,"error_code":404,"description":"Not Found"}` (это
  нормально: запрос без токена и метода, важен сам факт HTTP-ответа, а не таймаут).
- Вторая — начало JSON-документа со списком моделей (`{"data":[...`).

**Если что-то пошло не так:**

- Таймаут/`Could not resolve host` — проверьте `ufw status` (исходящий трафик по умолчанию
  разрешён, но провайдер мог блокировать DNS) и `cat /etc/resolv.conf`.
- Провайдер VPS блокирует Telegram/OpenRouter (редко для NL/DE, но встречается) — это критично:
  без доступа к обоим API бот не работает; меняйте провайдера или локацию.
- Именно это — способ проверить сценарий из п. 14: если с вашей локальной машины (например, из РФ)
  оба curl не проходят, а с сервера проходят, разработку стоит вести прямо на VPS (см. п. 14).

---

## 4. Установка Docker Engine и Compose plugin

Официальный способ установки из репозитория Docker (https://docs.docker.com/engine/install/ubuntu/):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# разрешить deploy запускать docker без sudo
sudo usermod -aG docker deploy
```

После этого выйти и снова зайти по SSH (чтобы группа `docker` применилась), затем проверить:

```bash
docker run --rm hello-world
docker compose version
```

**Ожидаемый результат:**

- `hello-world` печатает «Hello from Docker!».
- `docker compose version` печатает `Docker Compose version v2.x.x`.

**Если что-то пошло не так:**

- `permission denied while trying to connect to the Docker daemon socket` — не переподключились по
  SSH после `usermod -aG docker`; выйдите (`exit`) и зайдите заново, либо выполните `newgrp docker`.
- `E: Unable to locate package docker-ce` — репозиторий Docker не подключился для вашей версии
  Ubuntu; проверьте вывод `. /etc/os-release && echo "$VERSION_CODENAME"` — для 24.04 должно быть
  `noble`.

---

## 5. @BotFather: dev- и prod-боты

В Telegram открыть **@BotFather**:

```
/newbot
  → имя: Секретарь школы (dev)
  → username: <name>_dev_bot
/newbot
  → имя: Секретарь школы
  → username: <name>_bot
```

Для **каждого** из двух ботов:

```
/setprivacy    → выбрать бота → Disable
/setjoingroups → выбрать бота → Enable
/setdescription → выбрать бота → короткое описание на русском
/setuserpic    → выбрать бота → загрузить аватар
```

Сохранить оба токена (из ответа `/newbot`, вида `123456:ABC-DEF...`) — они понадобятся в `.env` как
`TELEGRAM_BOT_TOKEN` в `stb-dev` и `stb-prod` соответственно.

Свой Telegram ID узнать через любого бота вроде **@userinfobot**: написать ему `/start`, он пришлёт
ваш числовой ID — он понадобится как `SUPERADMIN_TG_IDS` (и, только для dev, `BOOTSTRAP_OWNER_TG_ID`).

**Важно:** `/setprivacy → Disable` нужно сделать **до** добавления бота в рабочие группы (SPEC,
CLAUDE.md «Грабли»). Если бот уже был добавлен в группу до отключения Privacy Mode — удалите его из
группы и добавьте заново, иначе он не увидит сообщения участников.

**Ожидаемый результат:** BotFather присылает `Done! Congratulations...` на `/newbot`, и `Success!`
на каждую из настроек. `@userinfobot` присылает ваш `Id: <число>`.

**Если что-то пошло не так:**

- `Sorry, this username is already taken` — username бота должен быть глобально уникальным,
  добавьте суффикс.
- Забыли токен — `/token` в BotFather (выбрать бота) покажет его снова; при компрометации —
  `/revoke`.

---

## 6. OpenRouter

1. Зарегистрироваться на https://openrouter.ai.
2. Пополнить баланс (раздел **Credits**).
3. Создать API-ключ: **Settings → Keys → Create Key**.
4. В настройках ключа выставить **лимит расходов** (spend limit) — это единственный аварийный
   тормоз на случай бага в промпте или бесконечного цикла; без него счёт может улететь.
5. Сохранить ключ как `OPENROUTER_API_KEY`.

**Ожидаемый результат:** страница ключа показывает `Limit: $<N>` и `Spent: $0.00` сразу после
создания.

**Если что-то пошло не так:**

- Ключ создан без лимита — вернуться в **Settings → Keys**, отредактировать ключ, задать `Credit
limit`.
- Списания идут быстрее ожидаемого — проверить `LLM_DAILY_BUDGET_USD` в `.env` (внутренний
  лимит бота) и `/admin` в боте (стоимость LLM за сегодня/месяц, SPEC §18).

---

## 7. Получение кода на сервере

Два варианта — выбрать один.

**Вариант А — образ из GHCR (рекомендуется, без сборки на сервере):**

```bash
# PAT с правом read:packages: github.com → Settings → Developer settings → Personal access tokens
echo "<PAT>" | docker login ghcr.io -u <ваш-github-логин> --password-stdin
```

При этом варианте с сервера всё равно нужны `docker/compose.yml`, `.env.example` и `scripts/*`;
проще всего получить их клонированием репозитория (шаг ниже) — образ приложения при этом всё равно
тянется из GHCR, `git clone` тут используется только для конфигурации и скриптов.

**Вариант Б / получение конфигурации:**

```bash
sudo mkdir -p /opt/stb-dev /opt/stb-prod
sudo chown deploy:deploy /opt/stb-dev /opt/stb-prod
git clone https://github.com/MozgovoyVF/school-task-bot.git /opt/stb-dev
git clone https://github.com/MozgovoyVF/school-task-bot.git /opt/stb-prod
```

**Ожидаемый результат:**

- `docker login ghcr.io` → `Login Succeeded`.
- `ls /opt/stb-dev` показывает `docker/`, `scripts/`, `.env.example`, `package.json` и т. д.

**Если что-то пошло не так:**

- `unauthorized: authentication required` при `docker login` — PAT не содержит `read:packages`
  либо истёк; создать новый в GitHub → Settings → Developer settings → Personal access tokens →
  Fine-grained/Classic, отметить `read:packages`.
- Репозиторий приватный/недоступен клонированием по HTTPS — используйте `git clone` с PAT в URL
  (`https://<PAT>@github.com/...`) или SSH-ключ, добавленный в GitHub.

---

## 8. Настройка `.env` и первый запуск

В каждом из `/opt/stb-dev` и `/opt/stb-prod`:

```bash
cd /opt/stb-dev
cp .env.example .env
chmod 600 .env
nano .env   # заполнить значения ниже
```

Заполнить как минимум: `TELEGRAM_BOT_TOKEN` (dev-бот из п. 5), `SUPERADMIN_TG_IDS` (ваш ID),
`BOOTSTRAP_OWNER_TG_ID` (тот же ваш ID — **только в dev**, в prod оставить пустым, SPEC §17.2),
`DATABASE_URL` (см. ниже), `OPENROUTER_API_KEY`, `BACKUP_AGE_RECIPIENT` (публичный ключ `age`,
появится в п. 10 — до этого можно оставить пустым, `scripts/backup.sh` пока не понадобится).

**Важно:** `.env.example` также содержит блок «только для Docker Compose»: `POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`, `COMPOSE_PROJECT`. Эти переменные не входят в SPEC §26 и не
валидируются `src/config/env.ts` (решение D37 в `plan.md` → «Решения и интерпретации»), но без них
`docker/compose.yml`'s `db` (образ `postgres:17`) не запустится и `scripts/deploy.sh`/`backup.sh`/
`restore.sh` не будут знать, какой compose-проект использовать. Заполнить обязательно:

```bash
# в .env — учётные данные должны совпадать с теми, что зашиты в DATABASE_URL ниже
POSTGRES_USER=stb
POSTGRES_PASSWORD=<вывод команды openssl rand -hex 24>
POSTGRES_DB=stb
# имя compose-проекта: stb-dev в /opt/stb-dev, stb-prod в /opt/stb-prod
COMPOSE_PROJECT=stb-dev
# порт НА ХОСТЕ (слушает только 127.0.0.1), у каждого стека свой: 3000 в stb-dev, 3001 в stb-prod
HTTP_PORT=3000
```

и привести `DATABASE_URL` к тем же учётным данным, например:
`DATABASE_URL=postgres://stb:<тот-же-пароль>@db:5432/stb`.

**Пароль генерируйте командой `openssl rand -hex 24`.** В hex-строке только `0-9a-f`, она
безопасна в обоих местах: символы `/`, `+`, `@`, `:` (частые в base64) ломают `DATABASE_URL`, а
`$` docker compose внутри `.env` считает подстановкой переменной.

**`HTTP_PORT` — это порт на хосте, а не внутри контейнера.** Приложение в контейнере всегда слушает
3000: `docker/compose.yml` задаёт `HTTP_PORT: '3000'` в `environment` сервиса `app`, и это
перекрывает значение из `.env` (на нём же завязан `HEALTHCHECK` образа). Значение из `.env`
используется только для публикации `127.0.0.1:<HTTP_PORT>:3000` и для проверок `/healthz` в
скриптах. Два стека на одном VPS (SPEC §17.1) не могут занять один порт хоста, поэтому в
`/opt/stb-dev/.env` оставьте `HTTP_PORT=3000`, а в `/opt/stb-prod/.env` укажите `HTTP_PORT=3001`.

`scripts/*.sh` читают `.env` построчно как `KEY=VALUE` и ничего из него не выполняют (решение D38
в `plan.md`), поэтому значения с пробелами и запятыми вроде `SUPERADMIN_TG_IDS=111, 222` или
`DEFAULT_WORKSPACE_NAME=Французская школа` допустимы без кавычек. Подстановку `${VAR}` внутри
значений скрипты не делают. Комментарий после значения отделяйте пробелом (`KEY=value # заметка`)
и **не ставьте комментарий после пустого значения**: и docker compose, и скрипты прочитают
`KEY=   # заметка` как значение `# заметка`.

**Первый запуск — всегда конкретный тег образа, никогда `latest`.** Тег должен уже быть
опубликован в GHCR workflow'ом `release.yml` (п. 11). Для самого первого релиза, когда git-тегов
ещё нет, его запускают вручную с ветки, из которой нужно собрать образ:

```bash
# на локальной машине
gh workflow run release.yml -f tag=v0.1.0-rc.1 --ref <ветка>
gh run watch
```

Теги `-rc` никогда не становятся `:latest`, поэтому после первого rc-релиза `:latest` в GHCR может
вообще не существовать. Деплой на него и не опирается.

Запуск на сервере (`scripts/compose.sh` — это `docker compose` для этого стека: сам берёт
`COMPOSE_PROJECT` и `HTTP_PORT` из `.env`, а тег из `APP_TAG` или `.deploy/current_tag`):

```bash
cd /opt/stb-dev
TAG=v0.1.0-rc.1                       # конкретный опубликованный тег
APP_TAG=$TAG ./scripts/compose.sh pull app
APP_TAG=$TAG ./scripts/compose.sh up -d
curl -fsS http://127.0.0.1:3000/healthz   # 3000 = HTTP_PORT этого стека (в stb-prod: 3001)
```

Когда `/healthz` ответил, запишите **этот же конкретный тег** как текущий:

```bash
mkdir -p .deploy && echo "$TAG" > .deploy/current_tag
```

В `.deploy/current_tag` всегда лежит реальный задеплоенный тег, никогда `latest`. По нему
`scripts/deploy.sh` откатывается при неудачном обновлении, `scripts/restore.sh` после
восстановления поднимает приложение ровно той же версии, а `scripts/backup.sh` и
`scripts/compose.sh` (без явного `APP_TAG`) без него не запускаются. `docker/compose.yml` без `APP_TAG` не работает
вообще (`required variable APP_TAG is missing a value`) и не подставляет `latest` молча.

Логи:

```bash
./scripts/compose.sh logs -f app
```

и в Telegram — открыть чат с dev-ботом, отправить `/start`.

**Ожидаемый результат:**

- `./scripts/compose.sh logs -f app` показывает JSON-строки pino без ошибок, среди них что-то вроде
  `"msg":"bot started"` / `"msg":"ticker started"` (точные сообщения — см. `src/app.ts`).
- `curl .../healthz` → `{"status":"ok"}` с кодом 200.
- `/start` в Telegram отвечает приветственным сообщением на «вы».

**Если что-то пошло не так:**

- `/healthz` возвращает 503 или соединение отклонено — смотреть `./scripts/compose.sh logs app`;
  частая причина — БД ещё не готова (`depends_on: condition: service_healthy` должен был это
  предотвратить) или неверный `DATABASE_URL`/`POSTGRES_*`.
- Контейнер `app` в `Restarting` — `./scripts/compose.sh logs app` покажет причину падения (обычно
  `EnvError` от zod-схемы `src/config/env.ts`: не хватает обязательной переменной).
- `/start` не отвечает — проверить `TELEGRAM_BOT_TOKEN` в `.env` и что `TELEGRAM_MODE=polling`.
- `manifest unknown` / `not found` при `pull app` — такого тега в GHCR нет: проверьте, что
  `release.yml` для него завершился успешно (`gh run list --workflow release.yml`), и что тег указан
  точно (`v0.1.0-rc.1`, а не `latest`).
- `port is already allocated` — `HTTP_PORT` в `.env` совпадает с портом другого стека на этом VPS
  (например, dev и prod оба на 3000); задайте разные значения, как описано выше.

---

## 9. Тестовая группа

1. В Telegram создать новую группу.
2. Добавить в неё dev-бота.
3. (Опционально) сделать бота администратором группы (без дополнительных прав) — это не
   обязательно на данном этапе, но пригодится позже для чтения истории и служебных сообщений.
4. Как Owner (ваш аккаунт с `BOOTSTRAP_OWNER_TG_ID`) — написать в группе сообщение с явным
   поручением, например: «Иван, отправь родителям расписание на завтра».

**Ожидаемый результат:**

- Сразу после добавления бота в группу вам в личку приходит уведомление о новом рабочем чате
  (SPEC §7 — критерий приёмки фазы 1; на момент Task 0.10 бот-скелет ещё не реализует пайплайн
  распознавания, поэтому карточка-предложение появится начиная с фазы 1/2 — здесь на фазе 0
  проверяется только сам факт, что бот подключается к группе и отвечает в личке).
- `curl .../healthz` продолжает отвечать `{"status":"ok"}`.

**Если что-то пошло не так:**

- Бот не видит сообщения участников — проверить `/setprivacy → Disable` (п. 5) и то, что бот был
  добавлен в группу **после** отключения приватности (переустановить, если добавляли раньше).
- Уведомление не пришло — проверить логи (`./scripts/compose.sh logs app`) на ошибки отправки
  сообщений (`Forbidden: bot was blocked by the user` и т. п. — тогда нужно самому написать боту
  `/start` в личку хотя бы один раз, Telegram не позволяет боту писать первым).

---

## 10. Бэкапы: установка `age`, ключи, cron, восстановление

Установка `age` (пакет есть в Ubuntu 24.04):

```bash
sudo apt-get install -y age
```

Генерация ключевой пары (один раз, на сервере — **приватный ключ сразу же скопировать к себе и
удалить с сервера**, хранить только офлайн/в менеджере паролей):

```bash
age-keygen -o /tmp/stb-backup-key.txt
cat /tmp/stb-backup-key.txt
# строка "Public key: age1..." идёт в .env как BACKUP_AGE_RECIPIENT
```

```bash
# скопировать приватный ключ к себе, например:
scp deploy@<IP>:/tmp/stb-backup-key.txt ~/secure/stb-dev-backup-key.txt
# и удалить с сервера
shred -u /tmp/stb-backup-key.txt
```

Добавить публичный ключ в `.env`:

```bash
echo 'BACKUP_AGE_RECIPIENT=age1...' >> /opt/stb-dev/.env   # заменить строку, а не дублировать
```

Ручной прогон бэкапа:

```bash
cd /opt/stb-dev
./scripts/backup.sh
```

Cron ежедневно в 03:00 UTC (crontab пользователя `deploy`; `scripts/backup.sh` сам находит и
подгружает `.env` из своего каталога — в crontab достаточно указать полный путь к скрипту, ничего
дополнительно экспортировать не нужно):

```bash
crontab -e
```

добавить строку:

```
0 3 * * * /opt/stb-dev/scripts/backup.sh >> /var/log/stb-dev-backup.log 2>&1
```

(аналогично для `/opt/stb-prod` со своим временем/строкой, если нужно развести по времени).

**Тест восстановления** (`scripts/restore.sh`) — выполнять на копии/тестовой БД, не на боевой без
крайней необходимости:

```bash
cd /opt/stb-dev
./scripts/restore.sh backups/stb-dev-<TIMESTAMP>.sql.gz.age ~/secure/stb-dev-backup-key.txt
```

**Ожидаемый результат:**

- `./scripts/backup.sh` печатает `Backup written: backups/stb-dev-<timestamp>.sql.gz.age` и
  `Backup sent to superadmin via Telegram.`; в личке у superadmin появляется файл-документ.
- `ls backups/` содержит не более 14 файлов на окружение (более старые удаляются автоматически).
- `./scripts/restore.sh` показывает версию, на которой перезапустит приложение (со строкой
  `The app will be restarted on its current version: <тег>`, где тег берётся из
  `.deploy/current_tag`), запрашивает подтверждение (`Type 'yes' to continue:`),
  затем печатает `Restore complete; app is healthy.`

**Если что-то пошло не так:**

- `backup.sh` падает с `POSTGRES_USER must be set` (или аналогично для другой переменной) — скрипт
  сам читает `.env` из своего каталога (`ROOT_DIR/.env`, где `ROOT_DIR` вычисляется от пути
  самого скрипта, а не от текущей директории), так что ошибка означает, что переменной
  действительно нет в `.env`; допишите её (см. п. 8) и запустите снова. При такой ошибке скрипт
  всё равно должен успеть отправить superadmin текстовое оповещение через `sendMessage` — если
  этого не произошло, значит не хватает именно `TELEGRAM_BOT_TOKEN`/`SUPERADMIN_TG_IDS` (без них
  оповещать некого) — тогда сообщение об ошибке будет только в выводе скрипта/логе cron.
- `no deployed tag recorded in .../.deploy/current_tag` (в `backup.sh` или `restore.sh`) — на этом
  стеке не записан текущий тег (п. 8). Запишите реально работающий тег:
  `echo v0.1.0-rc.1 > .deploy/current_tag` (посмотреть его можно в `docker ps` в колонке `IMAGE`).
  `restore.sh` проверяет это до остановки приложения и удаления БД, так что ничего не сломано.
- `age: error: no identity matched any of the recipients` при restore — использован не тот
  identity-файл (не пара к `BACKUP_AGE_RECIPIENT`, которым бэкап был зашифрован).
- Файл бэкапа не пришёл в Telegram, хотя скрипт завершился успешно — проверьте его размер
  (`ls -lh backups/`): при размере > 50 МБ скрипт сознательно не отправляет файл, это ожидаемое
  поведение (SPEC §27.10), заберите файл через `scp`.
- В cron бэкап не запускается — проверить `grep CRON /var/log/syslog` и что путь к `docker`/`age`
  есть в `PATH` для cron-окружения (у cron он минимальный); при необходимости прописать
  `PATH=/usr/bin:/usr/local/bin:/bin` первой строкой в crontab.

---

## 11. Обновление версии и откат

Новая версия образа публикуется в GHCR workflow'ом `release.yml` (решение D38 в `plan.md`):

- `git tag v0.2.0 && git push origin v0.2.0` — сборка коммита, на который указывает тег;
- или вручную: `gh workflow run release.yml -f tag=v0.2.0 --ref <ветка>` — сборка головы ветки,
  git-тег при этом не нужен и не создаётся.

Тег должен иметь вид `vX.Y.Z` или `vX.Y.Z-rc.N`. Финальные теги (`vX.Y.Z`) дополнительно двигают
`:latest` (это тот же образ, тот же digest), `-rc` — никогда, независимо от способа запуска.
Деплоится всегда конкретный тег:

```bash
cd /opt/stb-dev
./scripts/deploy.sh v0.2.0
```

Откат — деплой предыдущего тега тем же способом:

```bash
./scripts/deploy.sh v0.1.0
```

(`scripts/deploy.sh` также откатывается **автоматически**, если новый тег не прошёл проверку
`/healthz` в течение 90 секунд — см. `.deploy/current_tag` для текущего задеплоенного тега.)

Тот же сценарий можно запустить удалённо через уже существующий `.github/workflows/deploy.yml`
(требует настроенных secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` в репозитории на GitHub):

```bash
gh workflow run deploy.yml -f tag=v0.2.0 -f environment=dev
gh run watch
```

**Ожидаемый результат:**

- `./scripts/deploy.sh v0.2.0` печатает `Running pre-deploy backup...`, затем
  `Pulling and starting app:v0.2.0...`, затем `Deploy succeeded: v0.2.0 is live.`
- `cat .deploy/current_tag` → `v0.2.0`.
- `curl .../healthz` → `{"status":"ok"}`.

**Если что-то пошло не так:**

- `Health check failed for tag vX.Y.Z` + `Rolling back to <старый тег>...` — новая версия не
  поднялась; смотреть `./scripts/compose.sh logs app` на упавшем контейнере (миграция БД, `EnvError`
  и т. п.) **до** повторной попытки деплоя.
- `No previous tag recorded; nothing to roll back to` — `.deploy/current_tag` был удалён; поднимите
  заведомо рабочий тег вручную (`APP_TAG=<известный рабочий> ./scripts/compose.sh up -d`) и
  запишите его: `echo <известный рабочий> > .deploy/current_tag`.
- `refusing to deploy the floating tag 'latest'` — так и задумано: `deploy.sh` принимает только
  конкретный тег, иначе цель отката в `.deploy/current_tag` потеряла бы смысл.
- `COMPOSE_PROJECT must be set` — `deploy.sh` (как и `backup.sh`/`restore.sh`) сам читает `.env`
  из своего каталога, так что эта ошибка означает, что `COMPOSE_PROJECT` действительно не заполнен
  в `.env` (см. п. 8) — допишите `COMPOSE_PROJECT=stb-dev` (или `stb-prod`) и запустите снова.

---

## 12. Мониторинг

Логи:

```bash
./scripts/compose.sh logs -f app
./scripts/compose.sh logs -f db
```

Панель администратора — команда `/admin` в личке боту (только для `SUPERADMIN_TG_IDS`): версия
(git sha), аптайм, pending-сообщения по чатам, стоимость LLM за сегодня/месяц, статистика по
proposals за 7 дней (SPEC §18).

Диск:

```bash
df -h
docker system df
```

Внешний бесплатный мониторинг `/healthz` (например, UptimeRobot, Better Uptime — бесплатные планы)
станет доступен снаружи только после появления домена и HTTPS (п. 13, фаза 5); до этого `/healthz`
слушает `127.0.0.1` и проверяется только локально (см. `docker/compose.yml`: порт публикуется как
`127.0.0.1:${HTTP_PORT}:3000`, где `HTTP_PORT` — порт этого стека на хосте, 3000 или 3001).

**Ожидаемый результат:**

- `/admin` присылает карточку с версией и метриками (пустые/нулевые значения — это нормально сразу
  после первого запуска).
- `df -h` показывает свободное место на `/` заметно больше 0 (следите за ним — бэкапы копятся в
  `backups/`, до 14 файлов на окружение).

**Если что-то пошло не так:**

- `/admin` не отвечает — проверить, что ваш Telegram ID действительно в `SUPERADMIN_TG_IDS` в
  `.env`, и что после правки `.env` контейнер был перезапущен (`./scripts/compose.sh up -d` — он
  перезапустит именно текущий тег из `.deploy/current_tag`).
- Диск заполняется — проверить `docker system df`, почистить неиспользуемые образы:
  `docker image prune -f` (старые теги, замещённые новыми деплоями).

---

## 13. Домен и HTTPS (фаза 5)

Этот пункт актуален только с фазы 5 (Mini App/HTTP-эндпоинты наружу); на фазе 0 пропускается, но
приведён здесь для полноты SPEC §27.

1. Купить недорогой домен у любого регистратора (например, зона `.ru` или `.online`).
2. Создать A-запись, указывающую на IP VPS.
3. Добавить сервис `caddy` в compose (см. SPEC §5, §25 — планируется отдельным файлом
   `docker/compose.prod.yml` или аналогичным расширением к моменту фазы 5).
4. Открыть порты 80/443:
   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   ```
5. Проверить:
   ```bash
   curl -I https://<домен>
   ```

**Ожидаемый результат:** `curl -I https://<домен>` возвращает `HTTP/2 200` с валидным
Let's Encrypt-сертификатом (проверяется автоматически самим `curl`, без `-k`).

**Если что-то пошло не так:**

- Сертификат не выпускается — проверить, что A-запись уже распространилась (`dig <домен>`) и порт
  80 доступен снаружи (`ufw status`, а также правила файрвола провайдера, если есть отдельный
  security group).

---

## 14. Разработка, если РФ не может достучаться до Telegram/OpenRouter

Если с локальной машины (например, из России) `curl -sS https://api.telegram.org` или
`curl -sS https://openrouter.ai/api/v1/models` не проходят (см. проверку в п. 3), а с VPS —
проходят, разработку стоит вести прямо на сервере:

1. На VPS использовать dev-compose с bind-mount исходников и `tsx watch` вместо собранного образа:

   ```bash
   cd /opt/stb-dev   # тот же клон репозитория, что и выше
   docker compose -f docker/compose.dev.yml --env-file .env -p stb-dev-local up -d
   ```

   `docker/compose.dev.yml` публикует порты только на `127.0.0.1` (Postgres на 5433, приложение на
   `HTTP_PORT`). Это важно: опубликованные Docker'ом порты обходят `ufw`, а в этом файле Postgres с
   правами суперпользователя и паролем `stb`. Не меняйте привязку на `0.0.0.0`; снаружи к портам
   подключайтесь через SSH-туннель (см. ниже).

   **Конфликт с уже запущенным стеком `stb-dev`.** Если в `/opt/stb-dev` уже работает стек
   `stb-dev` (п. 8), то `stb-dev-local` с тем же `.env` столкнётся с ним дважды:
   - оба процесса будут опрашивать Telegram (`getUpdates`) с одним `TELEGRAM_BOT_TOKEN`, и Telegram
     начнёт отвечать `409 Conflict`, а апдейты будут доставаться то одному, то другому;
   - оба захотят порт хоста `HTTP_PORT` (3000), и второй не запустится с ошибкой
     `port is already allocated`.

   Поэтому перед запуском либо остановите `stb-dev` (`./scripts/compose.sh stop app`), либо
   заведите для разработки отдельного бота в @BotFather и отдельный `.env` с его токеном и другим
   `HTTP_PORT`.

2. Подключиться к серверу через **VS Code Remote-SSH** (расширение `ms-vscode-remote.remote-ssh`):
   `Cmd+Shift+P → Remote-SSH: Connect to Host... → deploy@<IP>`, затем открыть папку `/opt/stb-dev`.
3. Редактирование, git, терминал — как при локальной разработке, только выполняется на VPS, где
   Telegram/OpenRouter доступны напрямую.

**Ожидаемый результат:** VS Code показывает `SSH: <IP>` в левом нижнем углу, файлы репозитория
открываются и редактируются как локальные, `pnpm dev`/тесты выполняются в терминале VS Code на
сервере.

**Если что-то пошло не так:**

- Remote-SSH не подключается — убедиться, что ключ, которым подключаетесь локально по `ssh
deploy@<IP>`, добавлен в `~/.ssh/config` с тем же именем пользователя/портом, что использует
  обычный `ssh`.
- Порт для `pnpm dev`/HTTP недоступен из браузера локально — использовать проброс портов VS Code
  (`Ports` panel) или `ssh -L 3000:127.0.0.1:3000 deploy@<IP>`.
