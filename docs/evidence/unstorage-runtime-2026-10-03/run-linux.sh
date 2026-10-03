#!/bin/sh
set -eu
host='/mnt/host/c/Users/Swati Kale/.codex/diffci-evidence/2026-10-03'
root='/mnt/host/wsl/diffci-unstorage-20261003'
mkdir -p "$root"
if ! test -f "$root/usr/local/bin/node"; then mount -o loop "$host/linux-validation.ext4" "$root"; fi
umount "$root/proc" 2>/dev/null || true
mount -t proc proc "$root/proc"
umount "$root/sys" 2>/dev/null || true
mount -t sysfs -o ro sysfs "$root/sys"
if ! test -c "$root/dev/null"; then mount --bind /dev "$root/dev"; fi
if ! test -f "$root/evidence/safe-diffci.json"; then mount --bind "$host" "$root/evidence"; fi
cp /etc/resolv.conf "$root/etc/resolv.conf"
/usr/sbin/chroot "$root" "$@"
