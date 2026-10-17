#!/bin/sh
# Installs the beacon bridge as a systemd service on a Raspberry Pi (Raspberry Pi OS).
# Run from the folder holding bridge.py, install.sh and planit-beacon.service:
#   sh install.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
user=${SUDO_USER:-$(id -un)}

sudo apt-get update
sudo apt-get install -y python3-serial

# Serial ports (/dev/ttyACM*, /dev/ttyUSB*) belong to the dialout group.
sudo usermod -aG dialout "$user"

sudo install -d /opt/planit-beacon
sudo install -m 644 "$here/bridge.py" /opt/planit-beacon/bridge.py

sed "s/^User=.*/User=$user/" "$here/planit-beacon.service" | sudo tee /etc/systemd/system/planit-beacon.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable planit-beacon
sudo systemctl restart planit-beacon

echo "Installed. Check it with: systemctl status planit-beacon   or   journalctl -u planit-beacon -f"
