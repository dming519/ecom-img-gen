import postgres, { type Sql } from "postgres";

export interface HyperdriveBinding {
  connectionString: string;
}

export interface PostgresEnv {
  HYPERDRIVE?: HyperdriveBinding;
  POSTGRES_URL?: string;
}

export type AppSql = Sql;

const clients = new Map<string, Sql>();
const requestClients = new WeakMap<object, Map<string, Sql>>();

function createPostgresClient(connectionString: string, requestScoped: boolean) {
  return postgres(connectionString, {
    prepare: false,
    max: requestScoped ? 1 : 5,
    idle_timeout: requestScoped ? 1 : 20,
    connect_timeout: 10,
    fetch_types: false,
  });
}

export function getPostgres(env: PostgresEnv, label = "Postgres 数据库") {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error(`服务端未配置 ${label} Hyperdrive 绑定`);
  }

  if (env.HYPERDRIVE) {
    let scoped = requestClients.get(env);
    if (!scoped) {
      scoped = new Map<string, Sql>();
      requestClients.set(env, scoped);
    }

    let sql = scoped.get(connectionString);
    if (!sql) {
      sql = createPostgresClient(connectionString, true);
      scoped.set(connectionString, sql);
    }
    return sql;
  }

  let sql = clients.get(connectionString);
  if (!sql) {
    sql = createPostgresClient(connectionString, false);
    clients.set(connectionString, sql);
  }
  return sql;
}

export async function closeRequestPostgresClients(env: PostgresEnv) {
  const scoped = requestClients.get(env);
  if (!scoped) return;
  requestClients.delete(env);
  await Promise.all(
    [...scoped.values()].map((sql) => sql.end({ timeout: 1 }).catch(() => undefined)),
  );
}

export function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function runSchemaOnce(
  cache: WeakMap<Sql, Promise<void>>,
  sql: Sql,
  statements: string[],
) {
  let ready = cache.get(sql);
  if (!ready) {
    ready = (async () => {
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    })().catch((error) => {
      cache.delete(sql);
      throw error;
    });
    cache.set(sql, ready);
  }
  return ready;
}
