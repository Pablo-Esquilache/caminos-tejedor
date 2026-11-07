import pg from 'pg';

const { Client } = pg;

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(`
      SELECT id, original_name, status
      FROM public.trips
      WHERE status = 'approved'
      ORDER BY created_at ASC;
    `);
    console.log(`Encontrados ${res.rows.length} recorridos aprobados.`);
    for (const row of res.rows) {
      const c = await client.query(`SELECT public.consolidate_trip($1) AS result`, [row.id]);
      console.log(`✅ Recorrido "${row.original_name}" (${row.id}) consolidado:`, c.rows[0].result);
    }
    await client.query(`SELECT public.reclassify_all_roads()`);
    const roads = await client.query(`
      SELECT id, normalized_name, road_class, round(total_length_m::numeric, 1) AS length_m, approved_trips_count
      FROM public.roads
      ORDER BY total_length_m DESC;
    `);
    console.log('📊 Caminos consolidados actuales:', roads.rows);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
