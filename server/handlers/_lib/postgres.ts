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

export function getPostgres(env: PostgresEnv, label = "Postgres 数据库") {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error(`服务端未配置 ${label} Hyperdrive 绑定`);
  }

  let sql = clients.get(connectionString);
  if (!sql) {
    sql = postgres(connectionString, {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      fetch_types: false,
    });
    clients.set(connectionString, sql);
  }
  return sql;
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
