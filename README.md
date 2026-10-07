<img src="client/public/img/tardigrade.png" width="72" align="right" alt="">

# tardigrade

**A coding agent you can kill mid-task. It comes back and finishes the job.**

Give it a task, press **Kill it** while it works, and watch. Its Durable Object calls `ctx.abort()` on itself, so memory, sockets, and the model call in flight are lost. A second later a fresh instance reads the same SQLite, continues from the last saved step, and finishes. The conversation, the files, and the record of every kill survive, in every tab and after a refresh.

![Five kills in a row. Each shows Killed, then Back after, and the task still ends with one commit.](docs/kill5.gif)

*Five kills, eight seconds apart, sped up 1.8×. The task still ends with one file and one commit.*

tardigrade is a reference app to fork and run for yourself behind Cloudflare Access. It is not a hosted product, and it is not safe on the open internet: anyone who can open it spends your Workers AI budget.

## How it works

```
browser (Foldkit)
   │  effect/rpc over HTTP ─────▶ Worker: checks Access, forwards
   │  WebSocket (hibernatable) ─▶ Worker: checks Access, passes the socket through
   ▼
Durable Object "Agent", one per conversation
   ├─ Pi Durable harness, saved in the object's SQLite
   ├─ timeline of kills and comebacks, in the same storage
   └─ files: one Artifacts git repo, a commit per write
```

- **[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)** is the agent harness. Each model turn and each tool result is committed to SQLite before the next one starts. After a crash, the same request ID is submitted again, and Pi Durable continues from the last commit instead of starting over.
- **A Durable Object** holds one conversation: the harness, its storage, and the open WebSockets. The Worker checks Access and forwards. The WebSocket goes straight through to the object, so the object can hibernate while idle.
- **Cloudflare Artifacts** holds the files, in one git repo per conversation. Each `write_file` is a commit and a push, done with isomorphic-git on an in-memory filesystem.
- **[Effect](https://effect.website) v4** runs both sides. [`shared/protocol.ts`](shared/protocol.ts) defines every request, frame, event, and error as a Schema, and both sides import it. Effect gives typed errors at each boundary. It does not make the agent durable; Pi Durable and SQLite do that.
- **[Foldkit](https://foldkit.dev)** is the UI: one Model, one `update`, typed Messages, and story tests that run without a browser. Tailwind styles it, and Vite builds it into static assets that the Worker serves.

### What happens when you press Kill it

1. The object records the kill in storage (the time, and where in the transcript it happened). It counts one more life and sets an alarm for one second later.
2. It awaits `storage.sync()`, so that record cannot be lost, and then calls `ctx.abort()`.
3. The runtime discards the instance. Everything in memory is gone: the in-flight model call, the open WebSockets, and any unsaved work.
4. The next event for the object gets a fresh instance. That event is the alarm or the page reconnecting, whichever comes first. The fresh instance reads the same SQLite, finds the unfinished request, records a comeback, and submits the request again under the same ID.
5. Pi Durable continues from the last committed step. The step that was cut off runs again, so a model call that was in flight is made again.
6. Every open tab gets the new state over its WebSocket. The kill and the comeback are read from storage, so a refresh, or a tab opened later, shows the same transcript.

The same path covers deaths you did not cause. While a task runs, the object keeps a 15-second watchdog alarm. A deploy, an eviction, or an uncaught exception therefore ends in a comeback, not a stuck task.

### Replay is at-least-once

A kill can land after a tool ran but before its result was committed. That tool then runs again, so every tool must be safe to run twice:

| Tool | If it runs twice |
| --- | --- |
| `list_files`, `read_file` | Nothing changes. They only read. |
| `write_file` | Same path and same content make no new commit. If the model produced the step again with different content, there is one more commit. |

A task can end with one extra commit. It does not end with lost work. tardigrade does not promise exactly-once.

## Proof

### Kill it five times

`npm run kill5` sends a task, kills the agent five times about seven seconds apart, and waits. It passes only if all of these are true:

- There are 6 lives.
- The task finished.
- There is at least one commit and one file.
- The stored timeline has exactly 5 kills and 5 comebacks.

A real run against `npm run dev`:

```
send Success
kill 1: lives=2 busy=true
kill 2: lives=3 busy=true
kill 3: lives=4 busy=true
kill 4: lives=5 busy=true
kill 5: lives=6 busy=true
{"lives":6,"busy":false,"commits":1,"files":["index.html"],"replies":2,"timeline":"Killed,Back,Killed,Back,Killed,Back,Killed,Back,Killed,Back"}
# 2026-10-07, exit 0
```

### Pi Durable's storage suite, inside the real runtime

Pi Durable has a 23-case conformance suite for storage backends. Pi's own tests run the Durable Object adapter against a Node SQLite stand-in. [`test/conformance/`](test/conformance) instead starts real workerd with `wrangler`, opens the adapter on a Durable Object's SQLite, and runs the whole suite there. That checks transactions, ordering, and value types as the real runtime implements them. All 23 cases run on every `npm run check`.

### Every refresh shows the same page

The transcript is rebuilt from storage on every connect, not from what one tab saw. The story tests in [`client/src/story.test.ts`](client/src/story.test.ts) cover these cases:

- A page opened after a kill, before the comeback.
- A page opened after the comeback.
- A socket that reconnects and replaces the page's guess with the stored events.

## Run it locally

Before you start, you need:

- Node 22.19 or newer.
- A Cloudflare account with Workers AI.
- [Artifacts](https://developers.cloudflare.com/artifacts/) enabled in the dashboard. Artifacts is in beta. Without it, the first `write_file` fails.

```sh
npm install
npx wrangler login
npm run dev          # http://localhost:8787
```

Workers AI and Artifacts have no local simulator, so `npm run dev` uses the real services through remote bindings. Local runs spend your Workers AI quota and create real Artifacts repos, one per conversation. For costs, see [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and the [Artifacts docs](https://developers.cloudflare.com/artifacts/).

`npm run dev` skips the Access check, and only for requests to `localhost`, `127.0.0.1`, or `[::1]`.

```sh
npm run check                              # typecheck, lint, tests, storage suite in workerd, build, config checks
BASE=http://localhost:8787 npm run check   # the same, plus the five-kill run
```

The five-kill run calls the Worker without an Access token. It works against `npm run dev`, not against a deployed Worker.

## Deploy behind Cloudflare Access

tardigrade is locked by default. Every request, including the page and its images, must carry a Cloudflare Access token, and the Worker verifies the token itself: the signature against your team's keys, the audience, the issuer, and the expiry. There is no `workers.dev` or preview URL (`workers_dev: false`, `preview_urls: false`), so your Access hostname is the only way in.

You need a Zero Trust team and a zone in your account with a free Workers custom-domain slot (each zone allows 100).

1. Add your hostname to `wrangler.jsonc`:

   ```jsonc
   "routes": [{ "pattern": "tardigrade.example.com", "custom_domain": true }]
   ```

2. In Zero Trust, open **Access > Applications** and add a **self-hosted** application for that hostname. Give it one **Allow** policy that includes only your email address. Do not add a Bypass policy.
3. On the application's **Overview** tab, copy the **Application Audience (AUD) Tag**. In `wrangler.jsonc`, set `vars.ACCESS_AUD` to that tag and `vars.ACCESS_TEAM_DOMAIN` to `https://<your-team>.cloudflareaccess.com`. Neither value is a secret.
4. Optionally, set `vars.MODEL` to any Workers AI model with function calling. The default, `@cf/zai-org/glm-5.3`, streams tool arguments, so the page can show a file while it is being written.
5. Run `npm run deploy`. Wrangler deploys to the account you are logged in to; there is no account ID to configure.

Then open your hostname, sign in through Access, and give it a task.

## When it breaks

| You see | It means | Do this |
| --- | --- | --- |
| `503 tardigrade is locked` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing or malformed. | Set both in `vars`, then deploy again. |
| `401 sign in through Cloudflare Access` | The request had no Access token, so the hostname is probably not covered by your Access application. | Make sure the application's domain matches the route exactly. |
| `403 Access token rejected: wrong audience` | The token is for a different Access application. | Copy `ACCESS_AUD` from this application's Overview tab. |
| `403 Access token rejected: …` (any other reason) | The token is expired, malformed, or from another team. The reason names the failed check. | Sign in again. If it repeats, check `ACCESS_TEAM_DOMAIN`. |
| A write fails and the agent reports an error | Artifacts is not enabled, or the push was rejected twice in a row (a push is retried once). | Enable Artifacts, then send the task again. |
| **Working** for a long time | The model or Artifacts is slow. The watchdog revives a dead instance within 15 seconds, but it does not cancel a slow live one. | Press **Kill it**. The comeback resumes the task. |
| A conversation never loads after a kill | A known open bug: a kill at the wrong moment can leave Pi Durable's live document unreadable (`unresolvable path: ["generation"]`). | Press **New** for a new conversation. If you can reproduce it, please open an issue with the steps. |

The Worker also refuses writes and WebSocket connections from other origins, so another site cannot drive your agent through your signed-in browser.

## Layout

| Path | What it does |
| --- | --- |
| `shared/protocol.ts` | Schemas for every request, frame, timeline event, and error, imported by both sides |
| `worker/index.ts` | Checks Access on every request, serves the RPC group, checks the origin, and forwards the WebSocket to the conversation's Durable Object |
| `worker/access.ts` | Verifies the Access token: signature, audience, issuer, and expiry |
| `worker/agent.ts` | The `Agent` Durable Object: harness, tools, kill and comeback, watchdog, broadcast |
| `worker/meta.ts` | Small keyed state in the object's storage: the pending request, lives, and the timeline |
| `worker/view.ts` | Turns Pi's messages into the blocks the page shows |
| `worker/files.ts`, `worker/memfs.ts` | One Artifacts git repo per conversation, with isomorphic-git on an in-memory filesystem |
| `worker/model.ts` | Sends Pi's Workers AI calls through the AI binding |
| `worker/vendor/` | A generated copy of Pi's Durable Object SQLite adapter |
| `client/src/` | The Foldkit app and its story tests |
| `test/conformance/` | Pi Durable's storage suite, run inside workerd |
| `scripts/` | The check script, the five-kill run, and the two vendoring scripts |

### Design notes

- **Values cross the Durable Object boundary as JSON strings.** Durable Object RPC uses structured clone, which drops the classes Effect uses for errors and results. Each method encodes with the shared Schema and the Worker decodes it, so a wrong field is a decode error, not a silent `undefined`.
- **HTTP for requests, a WebSocket for pushes.** Snapshot, Send, Kill, and ReadFile are one `effect/rpc` group over HTTP. Pushes go over a hibernatable WebSocket as Schema-encoded frames: live text, blocks, files, kills, and comebacks. A streaming RPC would keep the object awake. A hibernated socket does not.
- **The timeline lives next to the work.** Kills, comebacks, and failures are stored in the same Durable Object as the harness, each with the transcript position where it happened. An event is stored before its frame is sent, so what a tab saw and what a refresh shows cannot drift apart.
- **The SQLite adapter is vendored.** Pi's Durable Object adapter is on Pi's `main` branch but not yet in a release. `npm run vendor:pi-durable` regenerates the copy from a pinned commit. Delete `worker/vendor/` when `@earendil-works/pi-durable` ships the `storage/sqlite/cloudflare` export.

## Contributing

Read [AGENTS.md](AGENTS.md) first. `npm run check` must pass. The lint is [anti-slop](https://github.com/dmmulroy/anti-slop), vendored into `tools/oxlint/anti-slop` by `npm run vendor:anti-slop`. If you change the agent, revival, or the protocol, also run the five-kill check.

## License

MIT
