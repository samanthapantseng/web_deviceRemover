#!/usr/bin/env bash
# The https certificate for `npm run dev:ipad`. Safari only allows the camera on https pages
# (or on localhost, which the iPad is not).
#
# First run: creates a small certificate authority (CA) for this Mac and shows its certificate
# in Finder. Install that on the iPad once (README, "iPad: before the first time"). Every run: issues a
# fresh server certificate, signed by that CA, for this Mac's network name and current
# addresses, so moving to another network needs no reinstall on the iPad.
#
# The CA can only vouch for local names (*.local, localhost) and private network addresses
# (name constraints): even if its key leaked, it could not impersonate a real website.
# The keys live outside the project folder, so the dev server can never hand them out.
set -euo pipefail

DIR="${DEVICE_REMOVER_CERTS:-$HOME/Library/Application Support/Device Remover/certs}"
CA_KEY="$DIR/ca.key"
CA_CERT="$DIR/device-remover-ca.pem"
KEY="$DIR/server.key"
CERT="$DIR/server.pem"

HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CERT" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$CA_KEY" 2>/dev/null
  cat >"$tmp/ca.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Device Remover local CA ($HOST)
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:localhost, permitted;DNS:local, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:127.0.0.0/255.0.0.0
EOF
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days 1095 -config "$tmp/ca.cnf" -extensions ca -out "$CA_CERT"
  chmod 644 "$CA_CERT"
  echo "Created a certificate authority for this Mac:"
  echo "  $CA_CERT"
  echo "Install it on the iPad once (AirDrop it, then Settings > General > About > Certificate Trust Settings)."
  echo "See README, \"iPad: before the first time\"."
  [ -z "${CI:-}" ] && command -v open >/dev/null && open -R "$CA_CERT" || true
fi

# Names the iPad may use to reach this Mac: its Bonjour name, and its private IPv4 addresses.
san="DNS:localhost,DNS:$HOST.local,IP:127.0.0.1"
addresses=""
while read -r ip; do
  [ -n "$ip" ] || continue
  san="$san,IP:$ip"
  addresses="$addresses $ip"
done < <(ifconfig | awk '/inet / {print $2}' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' || true)
# The fixed address of the Ethernet cable to the iPad (README), always included: then it does
# not matter whether the cable is plugged in when the server starts.
WIRED_IP="${DEVICE_REMOVER_WIRED_IP:-192.168.77.1}"
case ",$san," in
  *",IP:$WIRED_IP,"*) ;;
  *) san="$san,IP:$WIRED_IP" ;;
esac

cat >"$tmp/server.ext" <<EOF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $san
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY" 2>/dev/null
openssl req -new -key "$KEY" -subj "/CN=$HOST.local" -out "$tmp/server.csr"
# 397 days: under Apple's limit for certificates (825 days for user-installed CAs).
openssl x509 -req -in "$tmp/server.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" -set_serial "0x$(openssl rand -hex 16)" \
  -sha256 -days 397 -extfile "$tmp/server.ext" -out "$CERT" 2>/dev/null

echo "https certificate for $HOST.local$addresses"
