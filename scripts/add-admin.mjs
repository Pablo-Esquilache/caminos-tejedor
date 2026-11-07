import pg from 'pg';

const { Client } = pg;

async function main() {
  const email = process.argv[2] || 'pabloesquilache@gmail.com';
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const userRes = await client.query(
      `SELECT id, email, raw_user_meta_data FROM auth.users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );

    if (userRes.rowCount === 0) {
      console.error(`❌ No se encontró el usuario ${email} en auth.users`);
      process.exit(1);
    }

    const user = userRes.rows[0];
    console.log(`👤 Usuario encontrado en auth.users: ${user.email} (id: ${user.id})`);

    // Asegurar que exista en public.profiles
    await client.query(
      `INSERT INTO public.profiles (id, full_name, email)
       VALUES ($1, COALESCE($2, split_part($3, '@', 1)), $3)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
      [user.id, user.raw_user_meta_data?.full_name || 'Pablo Esquilache', user.email]
    );

    // Agregar a public.admins
    await client.query(
      `INSERT INTO public.admins (user_id, created_by)
       VALUES ($1, $1)
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id]
    );

    const checkRes = await client.query(
      `SELECT a.user_id, p.email, p.full_name, a.created_at
       FROM public.admins a
       JOIN public.profiles p ON p.id = a.user_id
       WHERE a.user_id = $1`,
      [user.id]
    );

    console.log('✅ Administrador registrado exitosamente en public.admins:', checkRes.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
