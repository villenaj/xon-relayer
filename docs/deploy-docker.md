This moves the running server from the systemd units to Docker. It keeps the same settings file, key and state directory, so the relayer picks up from its checkpoints. Downtime is the few seconds between stopping systemd and starting the containers. Run everything on the server, from `/opt/xon-relayer`.

### 1. Install Docker
Skip this if `docker compose version` already works.
```bash
curl -fsSL https://get.docker.com | sudo sh
```

### 2. Pull and build while systemd is still running
```bash
cd /opt/xon-relayer && sudo git pull
sudo docker compose build    # also runs the typecheck and unit tests
```

### 3. Give the key to the container
The container runs as uid `10001`, and it reads the key from `/etc/xon-relayer/relayer-key`.
- **Ubuntu 22.04 (file key):** the file is already there.
- **Ubuntu 24.04 (encrypted `relayer-key.cred`):** decrypt it once:
  ```bash
  sudo systemd-creds decrypt /etc/xon-relayer/relayer-key.cred /etc/xon-relayer/relayer-key
  ```
Then, for both:
```bash
sudo chown 10001:10001 /etc/xon-relayer/relayer-key && sudo chmod 400 /etc/xon-relayer/relayer-key
```
`/etc/xon-relayer.env` stays as it is. Compose reads it directly, so write any `$` in a value as `$$`.

### 4. Switch over
```bash
sudo systemctl disable --now xon-api xon-relayer   # graceful: waits for in-flight payouts
sudo systemctl mask xon-api xon-relayer            # so nothing can start a second relayer
sudo chown -R 10001:10001 /var/lib/xon-relayer
sudo docker compose up -d
sudo docker compose logs -f relayer
```
The mask step matters. The relayer's lock file can't see processes outside its container, so a systemd relayer and a container relayer would both run.

A healthy startup log shows:
- `Relayer address: ...` matching the contract's relayer;
- `On-chain external limits: ...` with no warnings;
- each adapter as `Watching ...`.

### 5. Check it
```bash
sudo docker compose ps                                    # both containers "Up", relayer "(healthy)"
curl -s http://127.0.0.1:9464/health                      # 200 = all adapters caught up
curl -s http://127.0.0.1:8080/api/health
sudo /opt/xon-relayer/docker/xon-relayer-cmd reconcile    # should say "No problems found"
```
Update the reconcile cron entry with `sudo crontab -e`:
`0 6 * * * /opt/xon-relayer/docker/xon-relayer-cmd reconcile > /var/log/xon-reconcile.log 2>&1 || <your alert command>`

### Day to day
| Task | Command |
|---|---|
| Logs | `sudo docker compose logs -f relayer` (or `api`) |
| Stop / start | `sudo docker compose stop` / `sudo docker compose start` |
| Restart | `sudo docker compose restart relayer` |
| Update | `sudo git pull && sudo docker compose up -d --build` |

Stopping is graceful: Docker gives the relayer 150s to finish in-flight payouts. The containers come back after a reboot by themselves.

### Rolling back to systemd
```bash
sudo docker compose down
sudo chown -R xonrelayer:xonrelayer /var/lib/xon-relayer
sudo systemctl unmask xon-api xon-relayer
sudo systemctl enable --now xon-relayer xon-api
```
On 24.04 the encrypted `relayer-key.cred` is still in place. You can delete the decrypted `relayer-key` once you're back on systemd.
