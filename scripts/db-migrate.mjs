import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../supabase/migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ Falta la variable DATABASE_URL en el archivo .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('🔌 Conectado exitosamente a Supabase PostgreSQL (Session Pooler).');

  try {
    // Tabla de control de migraciones aplicadas
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE public._schema_migrations ENABLE ROW LEVEL SECURITY;
    `);

    // Si las 4 iniciales ya se habían aplicado antes de existir _schema_migrations, registrarlas
    const existingTables = await client.query(`
      SELECT count(*)::int AS cnt FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles';
    `);
    if (existingTables.rows[0].cnt > 0) {
      for (const initFile of [
        '20261106000001_initial_schema.sql',
        '20261106000002_functions_and_triggers.sql',
        '20261106000003_rls_and_storage.sql',
        '20261106000004_seed_initial_data.sql',
      ]) {
        await client.query(
          `INSERT INTO public._schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [initFile]
        );
      }
    }

    const appliedRes = await client.query(`SELECT filename FROM public._schema_migrations`);
    const appliedSet = new Set(appliedRes.rows.map((r) => r.filename));

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`⏭️  Ya aplicada: ${file}`);
        continue;
      }
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`🚀 Aplicando migración nueva: ${file}...`);
      await client.query(sql);
      await client.query(
        `INSERT INTO public._schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [file]
      );
      console.log(`✅ Migración aplicada: ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error aplicando migraciones:', err);
  process.exit(1);
});
