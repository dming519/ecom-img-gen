# Hyperdrive Postgres Storage Design

## Context

The project currently stores all business metadata in Cloudflare D1 through a `HISTORY_DB` binding. This includes history records, stored image indexes, cutout drafts, prompt cache records, managed users, user credit usage, access codes, redeem codes, and redeem-code usage.

The target database is the existing Cloudflare Hyperdrive configuration:

- Name: `ecom-img-gen`
- ID: `5331cfb2bd4a45038ac17671fed6d1d8`
- Origin: Supabase Postgres pooler
- Database: `postgres`

The project is still in development, so existing D1 data does not need to be migrated.

## Decision

Use native Postgres/Hyperdrive access instead of a D1 compatibility adapter.

The server code will use a Postgres client directly and rewrite all database calls to parameterized Postgres SQL. This avoids carrying D1 semantics into the new storage layer and makes future schema work clearer.

## Architecture

Add a small Postgres helper in `server/handlers/_lib/postgres.ts`:

- Accept `HYPERDRIVE.connectionString` from the Cloudflare runtime.
- Create a Postgres client with conservative connection settings.
- Expose `sql` for parameterized queries.
- Expose one-time schema initialization helpers where needed.

Update the storage modules:

- `historyStorage.ts` stores history payloads, image metadata, detail prompts, and cutout drafts in Postgres.
- `users.ts` stores managed users, usage counters, and admin metadata in Postgres.
- `accessCodes.ts` stores access-code records and hashes in Postgres.
- `redeemCodes.ts` stores redeem-code records, hashes, and usage records in Postgres.

The independent image Worker does not need Hyperdrive because it only uses KV and Durable Objects.

## Schema

Create a Postgres migration with the current application tables:

- `history_records`
- `cutout_drafts`
- `stored_images`
- `detail_prompts`
- `admin_meta`
- `managed_users`
- `user_usage`
- `access_codes`
- `access_code_hashes`
- `redeem_codes`
- `redeem_code_hashes`
- `redeem_code_uses`

Use Postgres-native types:

- `BIGSERIAL` for history IDs.
- `TEXT` for string identifiers and JSON payloads.
- `BIGINT` for millisecond timestamps and byte sizes.
- `INTEGER` for counts and credits.
- `BOOLEAN` for active flags.

Use `ON CONFLICT` for upserts and `RETURNING id` for inserts that need generated IDs.

## Deployment

Replace the D1 binding in root `wrangler.toml` with:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "5331cfb2bd4a45038ac17671fed6d1d8"
```

Keep R2 and KV bindings unchanged.

GitHub Actions already deploys Pages and the Worker on push to `main`. The Pages deployment will pick up the Hyperdrive binding from `wrangler.toml`.

## Validation

Run:

- `npm run check`
- `npm run build`
- `npx wrangler pages deploy dist --project-name ecom-img-gen`

After deployment, verify:

- Auth/session endpoints can create or read managed user records.
- History endpoints can create, list, update, and delete records.
- Product image uploads still store bytes in R2 and metadata in Postgres.
- Access-code and redeem-code admin flows still work.
