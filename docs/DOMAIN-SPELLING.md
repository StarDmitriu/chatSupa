# Написание домена

**Правильный домен:** **chatrassylka.ru** (одна буква «t»).

В реестре .ru зарегистрирован именно **chatrassylka.ru**. Вариант **chattrassylka.ru** (две «t») не существует и даёт NXDOMAIN.

- Сайт: **https://chatrassylka.ru** и **https://www.chatrassylka.ru**
- В nginx и Hestia используется `server_name chatrassylka.ru www.chatrassylka.ru`
- В Hestia домен может быть добавлен как «chattrassylka.ru» (папка конфигов) — это не мешает, главное чтобы `server_name` в nginx был **chatrassylka.ru**
