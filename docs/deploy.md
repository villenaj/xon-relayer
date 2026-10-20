I updated two repo files for Ubuntu 22.04: `systemd/xon-relayer-cmd` now uses whichever key file exists, and the README explains the 22.04 key setup. Commit and push them to `features` before setting up the server.

Below is the full sequence. It assumes your contracts are already deployed and their RPC endpoints are reachable from the server. Run `systemctl --version` on the server first: version 250 or higher (Ubuntu 24.04) uses the **encrypted** key, and 249 (Ubuntu 22.04) uses the **file** key.

### 1. Install Node.js 22
The service runs `/usr/bin/node`. Ubuntu's own `nodejs` package is too old, and an `nvm` install won't be at that path. Use NodeSource:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version   # v22.x, at /usr/bin/node
```

### 2. Service user and code
```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin xonrelayer
sudo git clone -b features https://github.com/villenaj/xon-relayer.git /opt/xon-relayer
cd /opt/xon-relayer
sudo npm ci && sudo npm test && sudo npm run build
```
Use `npm ci` without `--omit=dev`. The build needs TypeScript, which is a dev dependency.

### 3. Settings
```bash
sudo install -m 600 -o root -g root .env.example /etc/xon-relayer.env
sudoedit /etc/xon-relayer.env
```
In that file:
- **Delete the `RELAYER_PRIVATE_KEY` line.** The key goes in step 4. If it's in both places, the relayer refuses to start.
- **Don't set `CHECKPOINT_DIR`.** The service sets it to `/var/lib/xon-relayer`.
- Set:
  - `VENDING_ADDRESS`, the RPC URLs and the gateway addresses;
  - `XODE_CHAIN_ID` / `ETHEREUM_CHAIN_ID` / `ASSETHUB_CHAIN_ID`;
  - `MAX_EXTERNAL_*`, at or below the contract's on-chain limits;
  - `MIN_*_XON` and `ALERT_WEBHOOK_URL`;
  - `ENABLE_*_ADAPTER=false` for any leg you don't run.

### 4. The relayer key
**systemd 250+ (encrypted at rest):**
```bash
sudo mkdir -p /etc/xon-relayer
sudo systemd-creds encrypt --name=relayer-key - /etc/xon-relayer/relayer-key.cred   # paste key, Ctrl-D
```
**systemd 249, Ubuntu 22.04 (root-only file):**
```bash
sudo mkdir -p /etc/xon-relayer
sudo install -m 600 -o root -g root /dev/stdin /etc/xon-relayer/relayer-key   # paste key, Ctrl-D
```
The key works with or without `0x`.

### 5. Install and start
```bash
sudo cp /opt/xon-relayer/systemd/xon-relayer.service /etc/systemd/system/
```
On **systemd 249 only**, also run this and add the two lines below:
```bash
sudo systemctl edit xon-relayer
#   [Service]
#   LoadCredential=relayer-key:/etc/xon-relayer/relayer-key
```
Then start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xon-relayer
journalctl -u xon-relayer -f
```
A healthy startup log shows:
- `Relayer address: ...` matching the contract's relayer;
- `On-chain external limits: ...` with no warnings;
- each adapter as `Watching ...`.

The service refuses to start, with a clear error, if the key doesn't match the contract or a chain ID or contract address is wrong.

### 6. After it's running
```bash
curl -s http://127.0.0.1:9464/health                        # 200 = all adapters caught up
sudo /opt/xon-relayer/systemd/xon-relayer-cmd reconcile     # should say "No problems found"
```
- **Daily reconcile:** run `sudo crontab -e` and add:
  `0 6 * * * /opt/xon-relayer/systemd/xon-relayer-cmd reconcile > /var/log/xon-reconcile.log 2>&1 || <your alert command>`
- **Backups:** back up `/var/lib/xon-relayer`, which holds the ledger and checkpoints.
- **Ports:** nothing needs to be open inbound. `/health` listens on localhost only.
- **First run:** make one small deposit on each leg and confirm it's paid before announcing anything.

### Updating later
```bash
cd /opt/xon-relayer && sudo git pull && sudo npm ci && sudo npm test && sudo npm run build
sudo systemctl restart xon-relayer
```
The restart is graceful: it lets in-flight payouts finish first.

On Ubuntu 22.04 the relayer key sits on disk unencrypted, readable only by root. That's acceptable, but upgrading the server to 24.04 lets you use the encrypted credential.