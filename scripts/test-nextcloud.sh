#!/usr/bin/env bash
# Isolated integration test; never connects to an existing Nextcloud instance.
# Requirements: Docker daemon, curl, Python 3, Node.js 22+, tar.
set -euo pipefail

nextcloud_version="${1:-31}"
case "$nextcloud_version" in
  31|32|33|34) ;;
  *) echo 'Usage: bash scripts/test-nextcloud.sh [31|32|33|34]' >&2; exit 2 ;;
esac

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="twentyfortyeight-test-${nextcloud_version}-$$"
test_password="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
image_name="nextcloud:${nextcloud_version}-apache"
legacy_fixture=""

cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker logs --tail 100 "$container_name" >&2 || true
    docker exec "$container_name" tail -n 100 /var/www/html/data/nextcloud.log >&2 || true
  fi
  docker rm --force --volumes "$container_name" >/dev/null 2>&1 || true
  if [ -n "$legacy_fixture" ]; then rm -f "$legacy_fixture"; fi
  exit "$result"
}
trap cleanup EXIT

docker run --detach --name "$container_name" \
  --publish 127.0.0.1::80 \
  --env NEXTCLOUD_ADMIN_USER=admin \
  --env "NEXTCLOUD_ADMIN_PASSWORD=$test_password" \
  --env NEXTCLOUD_TRUSTED_DOMAINS=127.0.0.1 \
  --env SQLITE_DATABASE=nextcloud \
  "$image_name" >/dev/null

port="$(docker port "$container_name" 80/tcp | sed -n 's/^127\.0\.0\.1://p')"
test_url="http://127.0.0.1:$port"
ready=false
for attempt in $(seq 1 120); do
  if curl --noproxy 127.0.0.1 --fail --silent "$test_url/status.php" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(not (d.get("installed") and not d.get("maintenance")))' 2>/dev/null; then
    ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != true ]; then
    echo 'Nextcloud container stopped during installation.' >&2
    exit 1
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo 'Nextcloud installation did not become ready within 240 seconds.' >&2
  exit 1
fi

docker exec "$container_name" mkdir -p /var/www/html/custom_apps/twentyfortyeight
# Copy instead of bind-mounting: a private checkout can have mode 0700.
tar -C "$repo_dir" --exclude=.git --exclude=node_modules --exclude=work \
  --exclude=output -cf - . \
  | docker exec --interactive "$container_name" tar -xf - -C /var/www/html/custom_apps/twentyfortyeight
docker exec "$container_name" chown -R www-data:www-data /var/www/html/custom_apps/twentyfortyeight
docker exec --user www-data "$container_name" php occ config:system:set appstoreenabled --type=boolean --value=false
docker exec --user www-data "$container_name" php occ app:disable firstrunwizard
docker exec --user www-data "$container_name" php occ app:enable twentyfortyeight

for test_user in smoke-one smoke-two; do
  docker exec --user www-data --env "OC_PASS=$test_password" "$container_name" \
    php occ user:add --password-from-env "$test_user"
done

TEST_NEXTCLOUD_PASSWORD="$test_password" python3 "$repo_dir/scripts/smoke-nextcloud.py" "$test_url"
if [ -n "${TEST_BROWSER_SMOKE:-}" ]; then
  for legacy_user in smoke-legacy smoke-legacy-v2 smoke-legacy-ancestor; do
    docker exec --user www-data --env "OC_PASS=$test_password" "$container_name" \
      php occ user:add --password-from-env "$legacy_user"
  done
  legacy_fixture="$(mktemp)"
  docker exec --user www-data --env TFE_ISOLATED_TEST=1 "$container_name" \
    php custom_apps/twentyfortyeight/scripts/seed-legacy-game.php > "$legacy_fixture"
  TEST_NEXTCLOUD_PASSWORD="$test_password" TEST_LEGACY_GAME_FILE="$legacy_fixture" \
    node "$TEST_BROWSER_SMOKE" "$test_url"
fi
echo "Nextcloud $nextcloud_version integration checks passed."
