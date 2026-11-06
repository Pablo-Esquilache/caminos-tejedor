import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(__dirname, '../supabase/tests');

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
  console.log('🔌 Conectado a Supabase para ejecutar pruebas SQL de permisos...');

  client.on('notice', (msg) => {
    console.log(`   ${msg.message}`);
  });

  try {
    const files = fs
      .readdirSync(testsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const filePath = path.join(testsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`🧪 Ejecutando suite de pruebas: ${file}...`);
      await client.query(sql);
      console.log(`✅ Suite superada: ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Falló una prueba de permisos:', err.message);
  process.exit(1);
});
