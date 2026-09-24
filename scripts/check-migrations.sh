#!/usr/bin/env bash
# Fails when lib/db/schema.ts has changes no migration in drizzle/ carries.
#
# drizzle-kit exits 0 even when it cannot compare the two, on a schema that
# does not compile or a rename it has no terminal to ask about, and writes
# nothing, so an unchanged drizzle/ proves nothing. Only its own "No schema
# changes" passes; a new migration or an error fails.
out=$(npx drizzle-kit generate 2>&1 </dev/null)
echo "$out"
if ! grep -q 'No schema changes' <<<"$out"; then
  echo "lib/db/schema.ts has changes no migration carries, or drizzle-kit could not tell: run npm run db:generate and commit drizzle/."
  exit 1
fi
