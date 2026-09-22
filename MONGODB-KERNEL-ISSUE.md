# Open5GS outage: MongoDB will not start on kernel 7.0.0

**Recorded 2026-09-22. Status: unresolved, fix not yet applied.**

The 5G core has been unable to authenticate any UE since **2026-09-19 13:27**. The cause is not in
this repository. MongoDB refuses to start, so Open5GS UDR cannot serve subscriber data, so every
UE registration is rejected.

Everything below is measured on this machine, with the commands used to measure it.

---

## 1. Symptoms

Three user-visible symptoms, one cause:

| Symptom | Mechanism |
|---|---|
| Open5GS WebUI will not load | The WebUI is a MongoDB front end |
| A connected UE showed nothing in EdgeRIC | UE reached RRC and got an RNTI, then registration was rejected |
| The UE stopped connecting entirely | After repeated rejects the modem backs off |

---

## 2. Timeline

| When | What |
|---|---|
| Sep 16 15:14 | `mongodb-org 8.0.32` installed |
| Sep 16 12:36 – Sep 19 13:26 | Kernel `6.17.0-1029-nvidia` running, MongoDB healthy |
| Sep 19 13:22–13:23 | Large apt upgrade: `libc6 2.39-0ubuntu8.7`, `systemd 255.4-1ubuntu8.16`, others |
| **Sep 19 13:26:23** | **mongod's last ever log line — a clean shutdown, `exitCode: 0`** |
| Sep 19 13:27 | Reboot into `7.0.0-1019-nvidia` |
| Sep 19 13:41 | Reboot again into `7.0.0-1019-nvidia`; still running |
| Sep 19 onwards | mongod fails on every start attempt |

MongoDB shut down **cleanly** at 13:26 — the data is not corrupt. It has simply never started since.

---

## 3. Root cause

MongoDB 8.0.x refuses to start on Linux kernels **6.19 through 7.0.13**. This is a **kernel
regression**, not a MongoDB bug: an rseq (restartable sequences) refactoring broke the TCMalloc
allocator MongoDB vendors. Fixed upstream by "rseq: Cure refactoring regressions" (Thomas
Gleixner), backported to the 7.0.y stable series and released in **7.0.14**.

MongoDB ships a deliberate guard that exits rather than risk allocator corruption. Tracked as
[SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912); MongoDB 8.0.30 added
`SERVER-125742` — *"Remove the graceful exit for kernel version 7.0.14 and above"*.

This machine runs `7.0.0-1019-nvidia`, inside the affected range.

---

## 4. Evidence

### 4.1 The service dies instantly

```
$ systemctl status mongod.service
× mongod.service - MongoDB Database Server
     Active: failed (Result: exit-code) since Tue 2026-09-22 12:42:27 CDT
   Duration: 15ms
    Process: ExecStart=/usr/bin/mongod --config /etc/mongod.conf (code=exited, status=1/FAILURE)

$ ss -lntH 'sport = :27017'          # nothing listening
```

### 4.2 It dies before it can open its own log

`/var/log/mongodb/mongod.log` ends at the clean shutdown of Sep 19 13:26:23 and has **no entries
since**, despite hundreds of restart attempts. The guard fires during global initialisation,
before the log file is opened. Reproduced below: a 0-byte logfile.

### 4.3 Direct reproduction

Run exactly as systemd runs it, but against throwaway paths (the real database was never touched):

```
$ GLIBC_TUNABLES="glibc.pthread.rseq=0" MONGODB_CONFIG_OVERRIDE_NOFORK=1 \
    /usr/bin/mongod --dbpath <tmp>/db --logpath <tmp>/log/m.log --port 27095 --bind_ip 127.0.0.1
exit code: 1
{"s":"F","c":"CONTROL","id":12257600,"ctx":"main",
 "msg":"MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility
        with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912"}
logfile bytes: 0
```

Matches production exactly: exit 1, immediate, empty logfile.

### 4.4 The failure chain into Open5GS

`logs/runs/20260922T173344ZFEF4/open5gs/udr.log`:

```
[dbi] WARNING: Failed to connect to server [mongodb://localhost/open5gs]
[app] WARNING: Failed to initialize UDR
```

UDR exits, systemd restarts it, repeat — which is why it sat in `activating` and eventually
`start-limit-hit`. With UDR never listening on `127.0.0.200:7777`, the same run's `amf.log`:

```
[sbi] WARNING: Couldn't connect to server (7): Failed to connect to 127.0.0.200 port 7777
[gmm] ERROR: [suci-0-001-01-0-0-0-0001441648] HTTP response error [504]
[amf] WARNING: [suci-0-001-01-0-0-0-0001441648] Registration reject [90]
```

Repeated at 12:34:02, :12, :22, :32, :42 — every ten seconds.

### 4.5 The UE's side, from our own metrics database

```
run 20260922T173344ZFEF4 : 5 RNTIs (0x4601..0x4605), 953 ue_mac rows, ~190 rows each
run 20260922T173526ZD2DF : 257,699 messages, 0 UE samples, no RNTIs
```

Five RNTIs in 100 seconds is five attach attempts — each rejected, each retried with a fresh
RNTI, ~190 ms of MAC activity apiece. By the third run the modem had given up entirely.

---

## 5. Why upgrading packages does not fix this

The instinct to upgrade rather than downgrade is right. The upgrade path does not currently exist.

**MongoDB is already current.** `apt-cache policy mongodb-org` reports Installed 8.0.32,
Candidate 8.0.32. The repo is pinned to the 8.0 series
(`repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0`). A newer build would behave identically —
the guard is correct behaviour, not staleness.

**No newer kernel is available for this flavour.** Every nvidia kernel in the archive reports base
version `7.0.0`:

```
linux-image-7.0.0-1013-nvidia   linux-image-7.0.0-1016-nvidia
linux-image-7.0.0-1015-nvidia   linux-image-7.0.0-1018-nvidia
linux-image-7.0.0-1019-nvidia   <- newest available, currently running
```

`-1019` is Ubuntu's **ABI number, not the upstream patchlevel**. `uname -r` will read
`7.0.0-XXXX-nvidia` whichever one is installed, so MongoDB parses 7.0.0 < 7.0.14 and refuses
regardless of what the kernel actually contains.

And this kernel very likely still has the bug: it is `7.0.0-1019.19~24.04.2`, built **Sep 5**, and
its changelog contains **zero** mentions of rseq. Canonical has not rebased this flavour past the
fix.

---

## 6. An unexplained observation — do not act on this yet

Controlled A/B on kernel `7.0.0-1019-nvidia`, identical invocations except one environment
variable:

| Run | Environment | Result |
|---|---|---|
| A | *(none)* | **STARTED** — listening within 1 s |
| B | `GLIBC_TUNABLES=glibc.pthread.rseq=0` | **REFUSED** — SERVER-121912 |

`mongod.service` sets that variable:

```
Environment="GLIBC_TUNABLES=glibc.pthread.rseq=0"
```

So a systemd drop-in clearing it would very likely make the service start. **That is not a
recommendation.** The tunable disables glibc's rseq registration, which is the *mitigation* for
the very bug in question, and MongoDB refusing with the mitigation present while running without
it is backwards from a safety standpoint. The mechanism is not understood here.

Starting MongoDB with rseq active on a kernel carrying the rseq regression risks allocator
corruption — the failure mode would be intermittent crashes and silent data damage to the
subscriber database, rather than today's clean refusal. Do not do this to a bench you rely on
without understanding why it works.

Recorded because it is reproducible and may be the key to a proper fix later.

---

## 7. Recommended fix

Boot **`6.17.0-1032-nvidia`** — the current patched head of the 6.17 series, below the 6.19
threshold. This is not a downgrade in the security sense; it is newer than the `6.17.0-1029` this
machine ran on Sep 16–19 while healthy. Treat it as pinning to the last good series until
Canonical ships an nvidia kernel based on ≥ 7.0.14.

`6.17.0-1029-nvidia` is still installed with its matching nvidia modules, so it is a zero-install
option for an immediate test.

```bash
# 1. install (do NOT install the -64k variants)
sudo apt-get install -y \
  linux-image-6.17.0-1032-nvidia \
  linux-modules-6.17.0-1032-nvidia \
  linux-modules-nvidia-580-open-6.17.0-1032-nvidia

# 2. find the exact menu entry titles
sudo awk -F\' '/^menuentry |^submenu /{print $2}' /boot/grub/grub.cfg
sudo awk -F\' '/menuentry .*6\.17\.0-1032/{print $2}' /boot/grub/grub.cfg

# 3. one-shot boot (self-recovering: a failed boot falls back to 7.0.0)
sudo grub-reboot "Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1032-nvidia"
sudo reboot

# 4. verify
uname -r                    # 6.17.0-1032-nvidia
systemctl is-active mongod  # active
nvidia-smi                  # should work again — see section 8

# 5. Open5GS needs an explicit reset; it will NOT recover on its own
sudo systemctl reset-failed open5gs-udrd open5gs-pcfd
sudo systemctl start open5gs-udrd open5gs-pcfd

# 6. only after 1-5 pass, make it permanent
sudo sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=saved/' /etc/default/grub
sudo grub-set-default "Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1032-nvidia"
sudo update-grub
```

Step 6 matters: `/etc/default/grub` currently has `GRUB_DEFAULT=0` with `GRUB_TIMEOUT=0` and
`GRUB_TIMEOUT_STYLE=hidden`. The menu is hidden and the newest kernel always wins, so without a
permanent default the next reboot silently returns to 7.0.0 — possibly mid-experiment.

This is a headless DGX with a serial console at 921600. Have BMC or console access before
rebooting.

### Afterwards

- Power-cycle the UE or toggle airplane mode; it may be holding a forbidden-PLMN state.
- Confirm the SIM's IMSI is still provisioned in the WebUI before blaming the UE.
- Periodically check `apt-cache policy 'linux-image-7.0.0-*-nvidia'`. Once Canonical rebases onto
  ≥ 7.0.14, undo step 6 and return to the 7.x series.

---

## 8. Side effect: the GPU driver is also down

```
$ nvidia-smi
NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.

$ lsmod | grep ^nvidia      # nothing loaded
```

There is no `linux-modules-nvidia-580-open-7.0.0-1019-nvidia` package; the 6.17 kernels have
theirs installed. Booting 6.17 restores the GPU as well. Unrelated to the RAN stack — the X310 is
over Ethernet — but worth knowing if anything here starts using CUDA.

---

## 9. Separate issue, already resolved

Distinct from the above, and worth recording because it produced a similar-looking symptom
("nothing showing in EdgeRIC").

During the three runs on Sep 22 the dashboard was still serving the **wave-1a** build from
Sep 19 23:04. Wave 1a reads chart bounds from `raw_tti`; wave 1b made raw protobuf storage opt-in,
so the v2 recorder leaves that table empty:

```
v2 database: SELECT MIN(timestamp_us), MAX(timestamp_us) FROM raw_tti  ->  (None, None)
                                                          FROM ue_mac  ->  (valid range)
```

Result: blank charts even though run `...FEF4` held 953 rows across 5 RNTIs. Fixed by wave 1b's
bounds change; the dashboard was restarted onto the current build at 12:38 on Sep 22.

**Lesson:** restart `edgeric-dashboard.service` after any build, or the reader and recorder can
disagree about the schema. See `dashboard/docs/STATUS.md`.

### Also confirmed during this investigation

`dl_mcs` **is** populated by the real gNB — values spanning 0–28 appeared in `ue_mac`. However
96.9% of rows are `dl_mcs = 0` and only 3.1% had any PRBs scheduled, because no UE ever completed
registration. The plumbing works; whether MCS tracks real link adaptation still needs an attached
UE passing traffic.

---

## 10. How to recognise this again

If the WebUI is dead and UEs will not attach, check in this order:

```bash
systemctl is-active mongod                      # failed?
ss -lntH 'sport = :27017'                       # nothing listening?
systemctl is-active open5gs-udrd open5gs-pcfd   # activating / failed?
uname -r                                        # kernel in 6.19 .. 7.0.13?
```

If mongod is down, nothing else in the core matters — fix that first. And note that `journalctl -u
mongod` and `/var/log/mongodb/mongod.log` will both be **silent**, because the failure happens
before logging is initialised. Reproduce it by hand as in section 4.3 to see the real error.

---

## Sources

- [MongoDB 8.x and Linux Kernel 6.19 — MongoDB Community Hub](https://www.mongodb.com/community/forums/t/mongodb-8-x-and-linux-kernel-6-19/337547)
- [MongoDB 8.0 Is Incompatible with Linux Kernel 6.19 Through 7.0.13](https://github.com/yu-i-i/overleaf-cep/issues/190)
- [MongoDB fails to start on Linux kernel 6.19+ / 7.0.x (SERVER-121912)](https://github.com/bluewave-labs/Checkmate/issues/3842)
- [Resolve MongoDB 8+ crashing with kernel 6.19+](https://github.com/john-fotis/IaC/issues/37)
