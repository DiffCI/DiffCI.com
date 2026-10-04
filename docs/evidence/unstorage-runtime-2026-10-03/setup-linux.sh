#!/bin/sh
set -eu
host='/mnt/host/c/Users/Swati Kale/.codex/diffci-evidence/2026-10-03'
root='/mnt/host/wsl/diffci-unstorage-20261003'
image="$host/linux-validation.ext4"
test ! -e "$image"
truncate -s 8G "$image"
mkfs.ext4 -q -F "$image"
mkdir -p "$root"
mount -o loop "$image" "$root"
for layer in "$host"/node-image/layer-*.tar.gz; do tar -xzf "$layer" -C "$root"; done
mkdir -p "$root/proc" "$root/dev" "$root/evidence" "$root/work/unstorage"
mount -t proc proc "$root/proc"
mount --bind /dev "$root/dev"
mount --bind "$host" "$root/evidence"
cp /etc/resolv.conf "$root/etc/resolv.conf"
tar -xf "$host/unstorage-source.tar" -C "$root/work/unstorage"
chroot "$root" /bin/sh -c 'node --version; npm install -g corepack@0.35.0; cd /work/unstorage; CI=true corepack pnpm@11.21.0 install --frozen-lockfile --ignore-scripts > /evidence/linux-install.log 2>&1; corepack pnpm@11.21.0 build > /evidence/linux-build.log 2>&1'
