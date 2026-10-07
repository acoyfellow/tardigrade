# Working on tardigrade

Read the README first. These rules keep the repository honest and safe to publish.

## Before you say a change works

- Run `npm run check`. It must print `all checks passed`.
- If you changed the agent, the Durable Object, the protocol, or revival, also run `npm run dev` and then `BASE=http://localhost:8787 npm run check`. That adds the five-kill run. It must end with `lives` 6, `busy` false, at least one commit, and a timeline of 5 kills and 5 comebacks.
- If you changed the UI, look at it in a real browser. Make sure the page is focused: a page in a background tab does not paint new frames.

## Rules

- Effect stays at exactly `4.0.0`. Foldkit 0.166.0 requires that version.
- Every message that crosses a boundary (Durable Object RPC, HTTP RPC, WebSocket) is a Schema in `shared/protocol.ts`. Values cross the Durable Object boundary as JSON strings, because structured clone drops Effect classes.
- Use typed errors, not `try`/`catch` that discards the error. The anti-slop lint enforces most of this.
- Do not add source comments. Use names, types, and small functions instead.
- Do not edit `worker/vendor/` or `tools/oxlint/anti-slop/`. They are generated; rerun `npm run vendor:pi-durable` or `npm run vendor:anti-slop`.
- Keep `workers_dev: false` and `preview_urls: false` in every wrangler config.
- Every request must pass the Access check in `worker/access.ts`. Do not add routes before it, and do not widen the local-dev bypass beyond loopback hosts.
- Run one `wrangler dev` per `.wrangler/state` folder. Two servers on one folder run the same Durable Object twice and corrupt its SQLite. Use `--persist-to` for a second server.
- Never commit account IDs, API tokens, or internal hostnames.
- Mark a tool `replay: "safe"` (Pi Durable: an interrupted run may rerun on recovery) only if a second run with the same recorded arguments changes nothing. Add it to the replay table in the README.
- Timeline events (kills, comebacks, failures) are written to storage before their frame is sent. The page renders only what the server stored.

## Honesty in docs

- A killed step can run again. Never write "exactly once".
- Effect does not make the agent durable. Pi Durable and the Durable Object's SQLite do.
