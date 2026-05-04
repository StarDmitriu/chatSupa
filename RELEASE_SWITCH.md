Use `docker-compose.release.yml` for server deployment of this archived release.

Recommended server layout:

- current release: `/opt/chatrassylka`
- archived release candidate: `/opt/chatrassylka-20260409`

Before first start:

1. Copy the current server `.env.prod` into the new release directory.
2. Ensure `deploy/certbot/conf` and `deploy/certbot/www` are copied from the current release.

Start archived release:

```bash
cd /opt/chatrassylka-20260409
docker compose -f docker-compose.release.yml up -d --build
```

Rollback to current release:

```bash
cd /opt/chatrassylka-20260409
docker compose -f docker-compose.release.yml down
cd /opt/chatrassylka
docker compose up -d --build
```
