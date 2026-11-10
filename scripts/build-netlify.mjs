import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const rootDist = path.join(rootDir, 'dist');
const mobileDir = path.join(rootDir, 'apps', 'mobile');
const adminDir = path.join(rootDir, 'apps', 'admin');

function run(cmd, cwd = rootDir) {
  console.log(`▶ Ejecutando (${path.relative(rootDir, cwd) || '.'}): ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function ensureInstalled(dir) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    run('npm install --no-audit --no-fund', dir);
  }
}

// 1. Limpiar carpeta dist raíz
if (fs.existsSync(rootDist)) {
  fs.rmSync(rootDist, { recursive: true, force: true });
}
fs.mkdirSync(rootDist, { recursive: true });

// 2. Instalar y compilar App Móvil / Vecinos (en la raíz "/")
ensureInstalled(mobileDir);
run('npm run build', mobileDir);
fs.cpSync(path.join(mobileDir, 'dist'), rootDist, { recursive: true });

// 3. Instalar y compilar Panel de Administración (en "/admin")
ensureInstalled(adminDir);
run('npm run build -- --base=/admin/', adminDir);
const adminTarget = path.join(rootDist, 'admin');
fs.mkdirSync(adminTarget, { recursive: true });
fs.cpSync(path.join(adminDir, 'dist'), adminTarget, { recursive: true });

// 4. Escribir reglas _redirects para que tanto "/" (Vecinos) como "/admin" (Panel Municipal) funcionen
const redirectsContent = `/auth-callback.html  /auth-callback.html  200
/auth-callback       /auth-callback.html  200
/privacidad.html     /privacidad.html     200
/admin               /admin/index.html    200
/admin/*             /admin/index.html    200
/*                   /index.html          200
`;
fs.writeFileSync(path.join(rootDist, '_redirects'), redirectsContent, 'utf8');

console.log('✅ Build unificado completado en ./dist (App Vecinos en "/" y Panel Admin en "/admin")');
