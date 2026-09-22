# MongoDB and Open5GS kernel repair

The machine is currently booting `7.0.0-1019-nvidia`. MongoDB 8.0.32 refuses to start on this
kernel because of the known Linux rseq/TCMalloc incompatibility. The same kernel is also missing
the matching NVIDIA driver module.

The immediate recovery is to boot the already-installed, previously working
`6.17.0-1029-nvidia` kernel. After confirming the system works, install and switch to the newer
`6.17.0-1032-nvidia` kernel.

> This is a headless DGX. Have BMC or serial-console access available before rebooting.

## 1. One-shot boot into the installed 6.17 kernel

```bash
sudo grub-reboot 'Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1029-nvidia'
sudo grub-editenv /boot/grub/grubenv list
sudo reboot
```

After reconnecting, verify the running kernel:

```bash
uname -r
```

Expected:

```text
6.17.0-1029-nvidia
```

Do not continue until `uname -r` reports the 6.17 kernel.

## 2. Restore MongoDB, the GPU driver, and Open5GS

Restart MongoDB and confirm it is listening:

```bash
sudo systemctl restart mongod
systemctl is-active mongod
ss -lnt 'sport = :27017'
```

Expected results:

- `systemctl is-active mongod` prints `active`.
- `ss` shows a listener on port 27017.

Verify the NVIDIA driver:

```bash
nvidia-smi
```

Reset Open5GS's failed state and restart its services:

```bash
sudo systemctl reset-failed 'open5gs-*'
sudo systemctl restart 'open5gs-*'
systemctl --failed --no-pager
```

If any Open5GS service remains failed, inspect it with:

```bash
systemctl status SERVICE_NAME --no-pager -l
```

## 3. Prevent the next reboot from returning to kernel 7

The current saved GRUB target points to `6.17.0-1032-nvidia`, but that kernel is not yet installed.
Until it is installed, save the working 1029 kernel as the default:

```bash
sudo grub-set-default 'Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1029-nvidia'
sudo grub-editenv /boot/grub/grubenv list
```

Expected output includes:

```text
saved_entry=Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1029-nvidia
```

## 4. Install the newer safe 6.17 kernel

After MongoDB, Open5GS, and `nvidia-smi` work on 1029, install the current 6.17 kernel and its
matching NVIDIA modules:

```bash
sudo apt-get install -y \
  linux-image-6.17.0-1032-nvidia \
  linux-modules-6.17.0-1032-nvidia \
  linux-modules-nvidia-580-open-6.17.0-1032-nvidia
```

Regenerate GRUB, save the new kernel as the default, and reboot:

```bash
sudo update-grub
sudo grub-set-default 'Advanced options for DGX OS>DGX OS, with Linux 6.17.0-1032-nvidia'
sudo grub-editenv /boot/grub/grubenv list
sudo reboot
```

## 5. Final verification

```bash
uname -r
systemctl is-active mongod
ss -lnt 'sport = :27017'
nvidia-smi
systemctl --failed --no-pager
```

Expected kernel:

```text
6.17.0-1032-nvidia
```

MongoDB should be active, port 27017 should be listening, and `nvidia-smi` should display the GPUs.

If Open5GS did not recover automatically after the second reboot:

```bash
sudo systemctl reset-failed 'open5gs-*'
sudo systemctl restart 'open5gs-*'
```

## Important cautions

- Do not remove `6.17.0-1029-nvidia`; retain it as the known-good fallback kernel.
- Do not make production MongoDB data-directory changes. The database is not the cause.
- Do not bypass MongoDB's kernel compatibility guard as the primary repair.
- Do not return to the 7.0 kernel until the Ubuntu/NVIDIA kernel build contains the required rseq
  fixes and has matching NVIDIA driver modules.
