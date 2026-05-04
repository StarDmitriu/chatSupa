# Доступ по SSH только по публичному ключу

## Что сделано

1. **Ваш публичный ключ добавлен** в `/root/.ssh/authorized_keys`:
   - `ssh-ed25519 ... root@6360259-qz553580`
   - Также сохранён ключ Beget (beget-access-key) для доступа панели.

2. **Создан конфиг SSH** `/etc/ssh/sshd_config.d/99-key-only.conf`:
   - `PubkeyAuthentication yes` — вход по ключу включён
   - `PasswordAuthentication no` — парольная аутентификация отключена
   - `PermitRootLogin prohibit-password` — root только по ключу

3. **Правила Cursor** в `.cursor/rules/` — напоминания по безопасности (секреты, зависимости, SSH).

## Важно перед перезапуском SSH

**Сначала проверьте вход по ключу во втором сеансе.**

1. Не закрывая текущую сессию, откройте **второе** подключение к серверу (другой терминал/вкладка).
2. Подключитесь по ключу: `ssh -i /путь/к/приватному/ключу root@IP_СЕРВЕРА`
   - Или просто `ssh root@IP_СЕРВЕРА`, если ключ по умолчанию (~/.ssh/id_ed25519).
3. Убедитесь, что вход прошёл без запроса пароля.
4. Только после этого в первой сессии примените конфиг и перезапустите sshd:

```bash
sudo systemctl restart sshd
# или
sudo systemctl restart ssh
```

Если перезапустить sshd до проверки и ключ не сработает, вы можете потерять доступ. Панель Beget (ключ beget-access-key) при этом должна продолжать работать.

## Добавить ключ другому пользователю (например deploy)

```bash
sudo mkdir -p /home/deploy/.ssh
sudo bash -c 'echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINg/ceiVrK1UFd/5L8Lanvqax/3VCMod7Vs/+JaWR4jp root@6360259-qz553580" >> /home/deploy/.ssh/authorized_keys'
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

## Откат (вернуть вход по паролю)

Удалить или переименовать конфиг и перезапустить sshd:

```bash
sudo mv /etc/ssh/sshd_config.d/99-key-only.conf /etc/ssh/sshd_config.d/99-key-only.conf.bak
sudo systemctl restart sshd
```

После этого снова можно входить по паролю (не рекомендуется).
