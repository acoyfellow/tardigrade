<img src="client/public/img/tardigrade.png" width="72" align="right" alt="">

# tardigrade

**An agent you can kill, and it comes back.**

tardigrade is a small coding agent on Cloudflare. Give it a task, press **Kill it** partway through, and it comes back and finishes. You keep the conversation, the files and the live view.

![A glowing tardigrade standing on a purple crystal](docs/hero.jpg)

```
browser (Foldkit) ──RPC + WebSocket──▶ Worker (Effect) ──▶ Durable Object (one per conversation)
                                                           ├─ Pi Durable harness, checkpoints in the object's SQLite
                                                           └─ files: one Artifacts git repo, commit + push per write
```

- **[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)** is the agent harness. Every step is a checkpoint, so a dead run resumes instead of starting over.
- **A Durable Object** holds the harness, one per conversation. Pi Durable stores its checkpoints in the object's built-in SQLite through Pi's own Durable Object adapter. That adapter is on Pi's `main` branch but not yet in a release, so [`worker/vendor/`](worker/vendor) holds a generated copy (`npm run vendor:pi-durable` refreshes it). Delete it when `@earendil-works/pi-durable` ships the `storage/sqlite/cloudflare` export.
- **Cloudflare Artifacts** holds the files: one git repo per conversation, with a commit and push after every write.
- **[Effect](https://effect.website) v4** runs both sides. [`shared/protocol.ts`](shared/protocol.ts) defines every frame, request, and error as a Schema. The Worker serves those requests with `effect/rpc`, and the browser calls them with a typed client. Live updates come over a WebSocket as Schema-encoded frames, because a Durable Object can hibernate its sockets but not a streaming RPC.
- **[Foldkit](https://foldkit.dev)** is the UI: one Model, one `update`, typed Messages. Tailwind does the styling, and Vite builds it into `client/dist`, which the Worker serves as static assets.

Effect does not make the agent durable. Pi Durable and SQLite do that. Effect gives typed errors at every boundary: the Durable Object, Artifacts, the model, and the browser.

## Run it

You need Node 22+ and a Cloudflare account with Workers AI and [Artifacts](https://developers.cloudflare.com/artifacts/) enabled (Artifacts is in beta; enable it in the dashboard first).

```sh
npm install
npx wrangler login
npm run dev          # builds the client, then http://localhost:8787 (Access check skipped locally)
```

Workers AI and Artifacts have no local simulator, so `npm run dev` uses the real services through remote bindings (see `wrangler.jsonc`). That means local runs use your Workers AI quota and create real Artifacts repos, one per conversation.

```sh
npm run check        # typecheck, lint, UI tests, storage conformance in workerd, build, config checks
BASE=http://localhost:8787 npm run check   # the same, plus the five-kill run below
```

The lint is [anti-slop](https://github.com/dmmulroy/anti-slop), vendored into `tools/oxlint/anti-slop` by `npm run vendor:anti-slop`.

## Deploy

tardigrade is meant for one person or a small team, not the open internet: anyone who can open it can spend your Workers AI budget and create Artifacts repos. So it is locked by default, and it stays locked until you put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/).

1. Pick a hostname on a zone in your account and add it to `wrangler.jsonc`:

   ```jsonc
   "routes": [{ "pattern": "tardigrade.example.com", "custom_domain": true }]
   ```

2. In Zero Trust, create a self-hosted Access application for that hostname, with a policy that allows only you (for example, your email address).
3. Copy two values into `vars` in `wrangler.jsonc`: your team domain (`https://<team>.cloudflareaccess.com`) as `ACCESS_TEAM_DOMAIN`, and the application's Audience (AUD) tag as `ACCESS_AUD`. Neither is a secret.
4. Optionally set `vars.MODEL` to any Workers AI model with function calling. The default is `@cf/zai-org/glm-5.3`, which streams tool arguments, so the page can show a file while it is being written.
5. Run `npm run deploy`. Wrangler deploys to the account you are logged in to; there is no account ID to configure.

The Worker does not trust that Access sits in front of it. Every request, including the page and its images, must carry an Access token that the Worker verifies itself: signed by your team's key, for your application's audience, and not expired. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, every request gets a 503 that says tardigrade is locked. There is no `workers.dev` or preview URL (`workers_dev: false`, `preview_urls: false`), so the Access hostname is the only way in.

`npm run dev` skips the check with `LOCAL_DEV_WITHOUT_ACCESS=1`, and only for requests to `localhost`, `127.0.0.1`, or `[::1]`. Never set that variable on a deployed Worker.

The Worker also refuses writes and WebSocket connections from other origins, so another site cannot drive your agent through your signed-in browser.

The storage test (`test/conformance/`) starts a real workerd with `wrangler`, opens the adapter on a Durable Object's SQLite, and runs Pi Durable's own storage suite of 23 cases. Pi's tests use a Node SQLite stand-in, so this checks the part that only the real runtime can.

## The demo: kill it and watch it come back

1. Open the page and pick an example, or ask for something that takes a few steps.
2. While it's working, press **Kill it**. The Durable Object calls `ctx.abort()` on itself, so the agent dies mid-step. Its memory, open sockets and any model call in flight are all lost.
3. Before dying, the object sets an alarm for one second later. The alarm (or the page reconnecting, whichever comes first) starts a new instance.
4. The new instance sees the unfinished request it recorded in SQLite and counts one more **life**. It re-submits the request under the same ID, and Pi Durable replays from the last checkpoint instead of starting over.
5. Replaying a recorded tool call is safe. `read_file` and `list_files` only read, and `write_file` with identical content makes no new commit. If the kill lands before a tool call was recorded, the model runs that step again and may write slightly different content, which shows up as one more commit. The files come back from the Artifacts repo.
6. The page reconnects, shows how long the agent was gone, and carries on as it finishes the task. The step that was cut off restarts from its last checkpoint, so a model call that was in flight is made again.

## Kill it five times

One kill is easy to fake. This is the check we run (`npm run kill5`, with `BASE` set to a running Worker): send a task, kill the agent five times about 7 seconds apart, then wait.

```
kill 1: lives=2   kill 2: lives=3   kill 3: lives=4   kill 4: lives=5   kill 5: lives=6
{"lives":6,"busy":false,"commits":1,"files":["index.html"]}
```

Six lives, one finished file, one commit. Because a cut-off step can run again, some runs end with one extra commit; the task still finishes.

## Layout

| Path | What it does |
| --- | --- |
| `shared/protocol.ts` | Schemas for every frame, request, outcome, and error, used by both sides |
| `worker/index.ts` | Checks Access on every request, serves the RPC group, checks the origin, and opens the WebSocket to the conversation's Durable Object |
| `worker/access.ts` | Verifies the Cloudflare Access token: signature against your team's keys, audience, issuer, and expiry |
| `worker/agent.ts` | The `Agent` Durable Object: harness, tools, kill and revival, WebSocket broadcast |
| `worker/view.ts` | Turns Pi's messages into the Blocks the page shows |
| `worker/files.ts`, `worker/memfs.ts` | One Artifacts git repo per conversation, with isomorphic-git on an in-memory filesystem |
| `worker/model.ts` | Sends Pi's Workers AI REST calls through the AI binding |
| `worker/vendor/` | Generated copy of Pi's Durable Object SQLite adapter |
| `client/src/` | The Foldkit app: model, messages, update, commands, socket, views, story tests |
| `test/conformance/` | Pi Durable's storage suite, run inside workerd |
| `scripts/` | The check script, the five-kill run, and the two vendoring scripts |

There is a build step now: `npm run build` runs Vite on `client/`. `npm run dev` and `npm run deploy` run it for you.

## License

MIT
