#!/usr/bin/env bash
# Destroys the storescribe Droplet so billing stops. Data in Tiger Cloud is untouched.
set -euo pipefail
doctl compute droplet delete --tag-name storescribe --force
echo "Destroyed. Billing for the Droplet has stopped."
