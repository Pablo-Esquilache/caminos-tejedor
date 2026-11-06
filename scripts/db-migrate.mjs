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

  client.on('notice', (msg) => {
    console.log(`   [NOTICE] ${msg.message}`);
  });

  try {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`🚀 Aplicando migración: ${file}...`);
      await client.query(sql);
      console.log(`✅ Migración aplicada: ${file}`);
    }

    const res = await client.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'profiles', 'admins', 'trips', 'trip_tracks',
          'roads', 'road_segments', 'trip_segment_usage', 'road_name_aliases',
          'claim_categories', 'claims', 'claim_photos', 'claim_history',
          'notifications', 'audit_log', 'settings'
        )
      ORDER BY tablename;
    `);

    console.log(`\n📊 Tablas verificadas en esquema public (${res.rowCount}/15):`);
    for (const row of res.rows) {
      console.log(`   - ${row.tablename} (RLS: ${row.rowsecurity ? 'ACTIVO' : 'INACTIVO'})`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error aplicando migraciones:', err);
  process.exit(1);
});
