# Restoring the GardenForge server from a backup

> **Status: not yet executed. Verify on first install.** These steps were written from the
> PocketBase documentation (going-to-production "Backup and Restore", api-backups) and have not
> been run. Rehearse section 4 once, right after your first backup, before you ever need it.

## What a backup contains

| Made by | File | Contents |
| --- | --- | --- |
| `backup.sh` (default "api" mode) | `gf_YYYYMMDD_HHMMSS.zip` | PocketBase's own snapshot of the whole `pb_data` directory: the database (`data.db`), the logs database, and **every uploaded photo** under `storage/`. PocketBase leaves out only its local `backups/` folder. `backup.sh` refuses to keep a ZIP that has no `data.db`, or that has no `storage/` entries while `pb_data/storage` holds files. |
| `backup.sh --mode offline` | `gf_offline_YYYYMMDD_HHMMSS.tar.gz` | A `tar` of `pb_data` taken while PocketBase was stopped. Same contents. |

Each backup has a `.sha256` file next to it. The paths inside the ZIP are assumed to be relative
to `pb_data` (`data.db` at the top level). **Verify on first install** with
`unzip -l gf_….zip | head`.

Photos are only in these backups if PocketBase stores files on the local disk, which is the
default. If you ever switch "Files storage" to S3 in the dashboard, the photos are no longer in
these backups (PocketBase docs: files uploaded to S3 are excluded) and you must back up the bucket
separately.

## Rules for every restore

1. **Never delete the current `pb_data`.** Move it aside; delete it only after both devices have
   synced and you have checked the garden on each.
2. **Use the same PocketBase version** the backup was made with, or a newer one. Never an older
   one.
3. **Rotate the epoch afterwards** (section 3). The restored server is missing whatever changed
   after the backup was taken, while the phone and the PC may already consider those changes
   synced. A new epoch tells them to start over and re-send what they have.
4. Before syncing a device against a restored server, export a backup from the app on that
   device (Settings, export) as an extra copy.

## 1. Full restore with the command line (works for both formats)

Assumes the default install (`/opt/gardenforge`, user `gardenforge`) and backups in
`/srv/gardenforge-backups`; adjust the paths if yours differ.

```bash
# 0. If this is a new machine: install first (same or newer PocketBase version).
#    sudo ./server/install.sh --version 0.39.9
# 1. Check the backup is intact
cd /srv/gardenforge-backups
sha256sum -c gf_20261002_031700.zip.sha256          # must print "OK"

# 2. Stop the server and move the current data aside (nothing is deleted)
sudo systemctl stop gardenforge-pocketbase
sudo mv /opt/gardenforge/pb_data "/opt/gardenforge/pb_data.before-restore-$(date +%Y%m%d%H%M)"

# 3a. Unpack a ZIP backup ...
sudo install -d -m 0750 -o gardenforge -g gardenforge /opt/gardenforge/pb_data
sudo unzip -q gf_20261002_031700.zip -d /opt/gardenforge/pb_data
# 3b. ... or an offline tar.gz backup (it contains the pb_data folder itself)
# sudo tar -C /opt/gardenforge -xzf gf_offline_20261002_031700.tar.gz

# 4. Give the data back to the service user, start, check
sudo chown -R gardenforge:gardenforge /opt/gardenforge/pb_data
sudo systemctl start gardenforge-pocketbase
/opt/gardenforge/scripts/smoke.sh
```

Then do section 3.

## 2. Restore through the admin UI (ZIP backups, same machine)

PocketBase can restore a ZIP itself: **Dashboard > Settings > Backups**, upload the ZIP, then
choose **Restore**. It replaces `pb_data` and restarts the process; the previous data is kept
under `pb_data/.pb_temp_to_delete/` until the next start. PocketBase's JSVM API reference
(`restoreBackup`) describes this feature as experimental and UNIX-only, and it needs free disk space of about twice the backup
size. Reach the dashboard through the SSH tunnel (server/README.md, "Admin UI"). Then do
section 3.

## 3. After every restore: rotate the epoch

```bash
# The backup token in /etc/gardenforge/backup.env is a superuser token, so it can be reused here.
sudo bash -c 'set -a; . /etc/gardenforge/backup.env; curl -fsS -X POST \
  -H "Authorization: $PB_BACKUP_TOKEN" http://127.0.0.1:8090/api/gf/admin/rotate-epoch'
# -> {"rotated":1}
```

Without a backup token, sign in as the superuser first:

```bash
curl -fsS -X POST http://127.0.0.1:8090/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' -d '{"identity":"ADMIN-EMAIL","password":"ADMIN-PASSWORD"}'
# copy "token" from the reply, then:
curl -fsS -X POST -H "Authorization: TOKEN" http://127.0.0.1:8090/api/gf/admin/rotate-epoch
```

(Typing a password on the command line leaves it in your shell history; clear it afterwards with
`history -c`, or use the dashboard.)

What the devices must do when they see a new `epoch` in a push, pull or status reply: reset their
pull cursor to 0, pull everything, and re-push every local record whose content differs from the
server's, using the server's `rev` as `baseRev`. Conflicts are then resolved by the normal rule
and nothing is discarded. **This is a requirement for the client sync engine, which is not built
yet.**

A pull reply with `"cursorAhead": true` means a device's cursor is beyond the server's sequence
number, which also happens after a restore; the device must do the same full resync.

## 4. Rehearse a restore without touching the live server

```bash
mkdir -p /tmp/gf-drill/pb_data
unzip -q /srv/gardenforge-backups/gf_20261002_031700.zip -d /tmp/gf-drill/pb_data
/opt/gardenforge/bin/pocketbase serve --dir=/tmp/gf-drill/pb_data \
  --hooksDir=/opt/gardenforge/pb_hooks --migrationsDir=/opt/gardenforge/pb_migrations \
  --http=127.0.0.1:8099 --automigrate=false
```

From your computer, `ssh -L 8099:127.0.0.1:8099 YOU@SERVER`, open `http://127.0.0.1:8099/_/`, sign
in with the superuser as it was at backup time, and check that `gf_records` has the expected
number of rows and that a photo in `gf_photos` opens. Stop with Ctrl+C and delete
`/tmp/gf-drill`.

## 5. Getting back one old record or photo

There is no one-click way. Start a drill copy (section 4) from a backup taken before the loss,
find the record in `gf_records` or the photo in `gf_photos`, and copy what you need. Remember that
every conflict's losing version is already kept in `gf_conflicts` on the live server, so look
there first.
