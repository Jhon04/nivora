// Construye el `latest.json` que consultan las apps ya instaladas para saber si
// hay version nueva. Formato del updater de Tauri v2:
//
//   { version, pub_date, platforms: { "<target>-<arch>": { signature, url } } }
//
// La `signature` es el contenido literal del .sig que emite el bundler al
// firmar. La app la verifica contra la clave publica que lleva compilada
// (plugins.updater.pubkey), y si no cuadra rechaza la descarga.
//
//   node scripts/generar-latest-json.mjs --version v1.0.7 --repo Jhon04/nivora \
//     --assets release-assets --out release-assets/latest.json

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const version = (args.get('version') ?? '').replace(/^v/, '');
const repo = args.get('repo');
const assets = args.get('assets');
const out = args.get('out');

if (!version || !repo || !assets || !out) {
  console.error('Faltan argumentos: --version --repo --assets --out');
  process.exit(1);
}

// En un `workflow_dispatch` sobre una rama, --version llega como "main" y las
// URLs saldrian apuntando a un release que no existe. Mejor parar aqui.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version invalida: "${args.get('version')}". Esto solo funciona sobre un tag vX.Y.Z.`);
  process.exit(1);
}

/** Todos los ficheros bajo `dir`, recursivamente. */
function listar(dir) {
  const encontrados = [];
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) encontrados.push(...listar(ruta));
    else encontrados.push(ruta);
  }
  return encontrados;
}

const ficheros = listar(assets);

// El updater identifica la plataforma por esta clave exacta; no es un nombre
// libre. Solo se declaran los formatos que el updater sabe reemplazar: el .deb
// se publica igual, pero se actualiza por apt/manualmente, no por aqui.
const objetivos = [
  { clave: 'linux-x86_64', instalador: /\.AppImage$/ },
  { clave: 'windows-x86_64', instalador: /-setup\.exe$/ },
];

const platforms = {};
for (const { clave, instalador } of objetivos) {
  const binario = ficheros.find((f) => instalador.test(f));
  if (!binario) {
    console.error(`No se encontro instalador para ${clave} en ${assets}/`);
    process.exit(1);
  }

  const firma = ficheros.find((f) => f === `${binario}.sig`);
  if (!firma) {
    // Sin firma la actualizacion no se puede verificar, y publicar un
    // latest.json a medias dejaria a los clientes intentando y fallando.
    console.error(`Falta la firma de ${binario}. ¿Se compilo sin TAURI_SIGNING_PRIVATE_KEY?`);
    process.exit(1);
  }

  const nombre = binario.split('/').pop();
  platforms[clave] = {
    signature: readFileSync(firma, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${nombre}`,
  };
  console.log(`  ${clave}: ${nombre}`);
}

const manifiesto = {
  version,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(out, `${JSON.stringify(manifiesto, null, 2)}\n`);
console.log(`Escrito ${out} (version ${version})`);
