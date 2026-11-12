# Putting Recall online: the owner's runbook

This takes Recall from your computer to a small server of its own, at an HTTPS address your
friends and family can open on their phones. Follow the steps in order; each says where to run
it: **on your computer** or **on the server**.

Claude cannot do the first two steps for you: it cannot buy the server or the domain, or
pay for anything. Once you have them and have given it SSH access, it can run the rest.

The prices below are approximate, as of late 2026, and change from time to time.

| What | Roughly |
|---|---|
| A small server (VPS) | €4–6 a month |
| A domain name | $10–15 a year, about $1 a month |
| HTTPS certificate | free (Caddy gets it from Let's Encrypt) |
| **Total** | **about $6–8 a month** |

## 1. Buy a server and a domain

- **Server.** A [Hetzner Cloud](https://www.hetzner.com/cloud) **CX22** or similar: 2 vCPU,
  4 GB memory, 40 GB disk, about €4–6 a month. Any provider's smallest plan with 1–2 GB of
  memory is enough. Choose **Ubuntu 24.04** as the image and a location near you. When it
  asks for an SSH key, add yours (see step 3); you can also add it afterwards. Write down the
  server's **IPv4 address**, for example `203.0.113.10`.
- **Domain.** From any registrar (Cloudflare, Porkbun, Namecheap and so on). A subdomain of a
  domain you already own works just as well, for example `recall.yourname.com`.

The examples below use `recall.example.com` and `203.0.113.10`. Put in your own.

## 2. Point the domain at the server

In the registrar's DNS settings, add an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `recall` (or `@` for the bare domain) | `203.0.113.10` |

If your DNS is at **Cloudflare**, set the record's proxy status to **DNS only** (the grey
cloud, not the orange one). With the proxy on, every visitor reaches Recall from Cloudflare's
addresses, so they all share one login rate limit and can lock each other out, and Caddy's
certificate requests can fail.

If the server also has an IPv6 address, add an **AAAA record** with it too. Check that it has
taken effect before going on (it can take from a minute to an hour):

```bash
# On your computer
dig +short recall.example.com     # should print 203.0.113.10
```

Caddy needs this working to get the HTTPS certificate in step 3.

## 3. Log in with a key, and set the server up

```bash
# On your computer. Make a key first if you have none (press Enter at each question).
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519
ssh-copy-id root@203.0.113.10
ssh root@203.0.113.10 true        # should log in without asking for a password
```

Copy the deploy folder up and run the setup script once:

```bash
# On your computer, from the Recall folder
rsync -a deploy/ root@203.0.113.10:/root/recall-deploy/
ssh root@203.0.113.10 'bash /root/recall-deploy/setup.sh recall.example.com'
```

It installs Node 22 and Caddy, creates a `recall` user, the code folder `/opt/recall` and the
data folder `/var/lib/recall`, installs the `recall` service and the Caddy configuration, sets
Google Translate's voice first, and turns on a firewall that lets in only SSH (22), HTTP (80)
and HTTPS (443). It is safe to run again. It does not start Recall yet.

The code and the data are kept apart on purpose: `deploy.sh` replaces `/opt/recall` each time,
and never touches `/var/lib/recall`.

**Voices.** Google Translate's voice needs nothing installed. The other engines are optional:

- **Azure** needs only a key in `/var/lib/recall/tts.json` (see the README's Voices section).
- **Edge and Piper** (the offline fallback, Portuguese only) need Python. To add them, after
  step 5:

  ```bash
  # On the server
  apt-get install -y python3-venv ffmpeg
  cd /opt/recall && bash scripts/setup-voice.sh
  systemctl restart recall
  ```

  `ffmpeg` only makes Piper's audio smaller; Piper works without it. `deploy.sh` leaves these
  voices in place when it updates the code.

## 4. Move your data into the new database, and copy it up

Your decks are in `data/recall.json` today. The migration moves them into `data/recall.db`
under a new admin account, which is you, and checks every deck, card, count and setting came
across unchanged. If anything differs it stops and changes nothing.

Stop the old app first (Ctrl+C in its terminal), so the file is not changing underneath it.
Then, from the Recall folder:

```bash
# On your computer. Pick your own username and name; it asks for the password (8+ characters).
node scripts/migrate-json.js --data data --username yourname --name "Your Name"
```

It prints how many decks and cards it moved. `data/recall.json` is left as it was, as a
fallback.

**Do not start Recall on your computer between this step and the copy below.** A running
server keeps its newest changes in a side file, `data/recall.db-wal`, and copying
`recall.db` without it leaves them behind. If you did start it, stop it first (Ctrl+C), and if
a `data/recall.db-wal` is still there, copy it up together with `recall.db`.

Copy the database, the images and the saved audio to the server, and give them to the
`recall` user:

```bash
# On your computer
rsync -av --progress data/recall.db data/media data/audio root@203.0.113.10:/var/lib/recall/
ssh root@203.0.113.10 'chown -R recall:recall /var/lib/recall'
```

If Recall has already been started on the server and you are doing this again, stop it first
and remove the old database's side files, or they will be mixed into the new one:

```bash
# On the server
systemctl stop recall
rm -f /var/lib/recall/recall.db-wal /var/lib/recall/recall.db-shm
```

## 5. Deploy the code

```bash
# On your computer, from the Recall folder
bash deploy/deploy.sh root@203.0.113.10
```

It copies the code to `/opt/recall` (never your `data/`, `decks/`, PDFs or git history) and
restarts the service. It ends with `active` and `Deployed to ...` when Recall is running.

If it says something else, look at the log:

```bash
# On the server
journalctl -u recall -n 50 --no-pager
journalctl -u caddy -n 50 --no-pager    # certificate or proxy trouble
```

## 6. Open the site, log in, and invite people

1. Open **https://recall.example.com** and log in with the username and password from step 4.
   Your decks, today's counts and your streak should be exactly as they were on your computer.
2. Open the account menu (your name, top right) and choose **Admin**.
3. Under **Invite codes**, press **New invite code** and send the code to someone. They open
   the site, choose **Have an invite code? Sign up**, and enter the code, a username, their
   name and a password. A code can be made for up to 20 people (**Uses**).
4. Back in **Admin**, under **Your decks**, press **Give to…** on a deck and tick them. A given deck arrives on their reserve; they pull cards
   in at their own pace. Your later edits to the deck reach them, and their progress is kept.

There is no password-reset email. If someone forgets their password, set a new one for them
with **Reset password** under **Admin → People**, and tell them what it is.

## 7. Backups

The server copies the database once a day to `/var/lib/recall/backups/recall-YYYY-MM-DD.db`
and keeps the last 30. Each one is a complete database on its own. They are on the same
server, so copy one to your computer now and then:

```bash
# On your computer: list them, then copy one (or all) down
ssh root@203.0.113.10 'ls -lh /var/lib/recall/backups'
scp root@203.0.113.10:/var/lib/recall/backups/recall-2026-11-11.db ~/recall-backups/
rsync -av root@203.0.113.10:/var/lib/recall/backups/ ~/recall-backups/
```

Images and audio are not in the database. To keep a copy of those as well:

```bash
rsync -av root@203.0.113.10:/var/lib/recall/media ~/recall-backups/
```

**To restore a backup**, put it in place of the database while Recall is stopped:

```bash
# On the server
systemctl stop recall
cp /var/lib/recall/recall.db /root/recall-before-restore.db          # just in case
cp /var/lib/recall/backups/recall-2026-11-11.db /var/lib/recall/recall.db
rm -f /var/lib/recall/recall.db-wal /var/lib/recall/recall.db-shm
chown recall:recall /var/lib/recall/recall.db
systemctl start recall
```

To restore one from your computer, copy it up first:
`scp ~/recall-backups/recall-2026-11-11.db root@203.0.113.10:/var/lib/recall/backups/`.

Everything since that backup is lost for everyone, so restore only when something has really
gone wrong. Your hosting provider's own snapshots (about 20% of the server price at Hetzner)
are a further safety net if you want one.

## 8. Updating the app

When the code changes, on your computer:

```bash
git pull                                   # or make your changes
npm test                                   # everything should pass
bash deploy/deploy.sh root@203.0.113.10
```

The restart takes a couple of seconds. Anyone studying at that moment loses nothing: answers
that could not be sent are kept in their browser and sent once the server is back.

Ubuntu installs security updates on its own. Now and then, also run:

```bash
# On the server
apt-get update && apt-get upgrade -y
reboot                                     # if it says a restart is required
```

Recall and Caddy start again by themselves after a reboot.

## 9. Topics: the key and the one-off sort of Portuguese A1

Sorting cards into topics for the admin uses Anthropic's API, so it needs a key. Without one
everything else works and sorting is simply off. Give the key to the server in one of two
ways. Either put it in the data folder, readable only by the service user:

```bash
# On the server
cat > /var/lib/recall/claude.json <<'JSON'
{"apiKey": "sk-ant-...", "model": "claude-opus-5-5"}
JSON
chown recall:recall /var/lib/recall/claude.json
chmod 600 /var/lib/recall/claude.json
systemctl restart recall
```

or add `Environment=ANTHROPIC_API_KEY=sk-ant-...` to the `[Service]` section of the `recall`
unit (`systemctl edit recall`), then `systemctl restart recall`. To use a cheaper model later,
change `model`. Deploying now runs `npm ci` on the server (the Anthropic SDK is a dependency),
so the server needs internet access when you deploy; `deploy.sh` does it for you.

**The one-off sort.** Your Portuguese A1 cards came from the `new_cards_<topic>.csv` files.
This sorts the cards that match them into topics, with no AI involved (about 4,800 of the
6,500). Run it once after the first deploy that has topics:

```bash
# On your computer, from the folder that holds the new_cards_*.csv files
ssh root@203.0.113.10 'mkdir -p /tmp/topic-files'
scp new_cards_*.csv root@203.0.113.10:/tmp/topic-files/
ssh root@203.0.113.10 'chown -R recall:recall /tmp/topic-files'
```

```bash
# On the server. Stop the service first, as in step 4, so nothing changes underneath it.
systemctl stop recall
cd /opt/recall
# Dry run first: prints the counts and changes nothing.
sudo -u recall node scripts/assign-topics.js --data /var/lib/recall --username yourname \
  --deck "Portuguese A1" --files /tmp/topic-files --dry-run
# Then for real. It first saves /var/lib/recall/backups/recall-before-topics-<date>.db.
sudo -u recall node scripts/assign-topics.js --data /var/lib/recall --username yourname \
  --deck "Portuguese A1" --files /tmp/topic-files
systemctl start recall
rm -rf /tmp/topic-files
```

Use your own admin username. It only writes topics onto cards that have none; it never
touches a schedule or your progress, and it leaves a card unsorted if two files list it. It
refuses to run if that day's before-topics backup already exists. To undo it, stop the service
and copy that backup over `recall.db` (see step 7).

Then open Portuguese A1 in the app and press **Sort now** to place the remaining cards, about
1,700, with the AI. That costs a small charge per batch of about 100 cards.

