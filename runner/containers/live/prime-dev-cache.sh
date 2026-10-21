#!/bin/sh
# Image-build step: compile the starter's `/` route once and keep the dev cache
# as /baked/<key>/.next. The session boot script restores it into /app, so the
# first request does not pay the cold compile. Runs in /app because the cache
# records project-relative paths and the session serves from the same directory.
#
# usage: prime-dev-cache.sh <baked key> <port> <dev command>
set -e
key=$1
port=$2
cmd=$3

cd /app
cp -a "/prime/$key/." .
cp /baked/"$key"/package.json /baked/"$key"/pnpm-lock.yaml .
# A real copy, not `cp -al` like the session boot: hard-linking a file from an
# earlier image layer copies it up into this layer on overlayfs, so the layer
# would carry a second node_modules that the `find -delete` below cannot remove,
# and exporting it exhausts the build runner's memory. A copy made and deleted
# in this same layer never reaches it.
cp -a /baked/"$key"/node_modules ./node_modules

sh -c "exec $cmd" > /tmp/prime-dev.log 2>&1 &
dev=$!
node -e "
const http = require('http');
const deadline = Date.now() + 240000;
(function probe() {
  const q = http.get({ host: '127.0.0.1', port: ${port}, path: '/', headers: { host: 'localhost:${port}' }, timeout: 240000 }, (s) => {
    s.resume();
    process.exit(s.statusCode < 400 ? 0 : 1);
  });
  q.on('timeout', () => { q.destroy(); process.exit(1); });
  q.on('error', () => (Date.now() < deadline ? setTimeout(probe, 500) : process.exit(1)));
})();
" || { cat /tmp/prime-dev.log; exit 1; }

# Turbopack persists its cache in the background after the compile, and a stop
# before that loses it. Wait until the cache stops growing, then stop gracefully
# so the final flush runs.
cache=.next/dev/cache/turbopack
last=-1
stable=0
for _ in $(seq 1 60); do
  size=$(du -sk "$cache" 2> /dev/null | cut -f1)
  if [ "$size" = "$last" ]; then stable=$((stable + 1)); else stable=0; fi
  [ "$stable" -ge 3 ] && break
  last=$size
  sleep 2
done
[ "$stable" -ge 3 ] || { echo "prime-dev-cache: cache never settled" >&2; exit 1; }

kill -INT "$dev" 2> /dev/null || true
for _ in $(seq 1 30); do
  kill -0 "$dev" 2> /dev/null || break
  sleep 1
done
kill -KILL "$dev" 2> /dev/null || true
wait "$dev" 2> /dev/null || true
# pnpm may exit before the server it spawned; the cache is complete only once that is gone too.
for _ in $(seq 1 30); do
  pgrep -f "[n]ext-server" > /dev/null || break
  sleep 1
done

# A cache that is only a skeleton would ship silently and buy nothing.
[ "$(du -sk "$cache" | cut -f1)" -gt 1024 ] || { echo "prime-dev-cache: cache is empty" >&2; exit 1; }
rm -f .next/dev/lock
mv .next "/baked/$key/.next"
cd /
find /app -mindepth 1 -delete
