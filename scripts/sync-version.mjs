// Pone la misma versión en los tres sitios que la declaran: package.json,
// tauri.conf.json y src-tauri/Cargo.toml. El nombre del instalador lo decide
// tauri.conf.json, así que si se desincroniza salen ficheros tipo
// Nivora_0.1.0_amd64.deb colgando de un release v1.0.5.
//
//   node scripts/sync-version.mjs 1.0.5
//
// En CI lo llama el workflow de release con la versión sacada del tag.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Versión inválida: "${process.argv[2]}". Se espera x.y.z (o vx.y.z).`);
  process.exit(1);
}

function editar(ruta, transformar) {
  const absoluta = join(raiz, ruta);
  const antes = readFileSync(absoluta, 'utf8');
  const despues = transformar(antes);
  if (antes === despues) {
    console.log(`  = ${ruta} (ya estaba en ${version})`);
    return;
  }
  writeFileSync(absoluta, despues);
  console.log(`  ✓ ${ruta}`);
}

// En los JSON se sustituye la clave textualmente en vez de reserializar el
// objeto, para no reordenar claves ni cambiar el formato del fichero.
const versionJson = (texto) => {
  const re = /^(\s*"version":\s*)"[^"]*"/m;
  if (!re.test(texto)) throw new Error('no se encontró la clave "version"');
  return texto.replace(re, `$1"${version}"`);
};

// Solo la versión del propio paquete: es la primera que aparece, dentro de
// [package]. Las de [dependencies] van más abajo y no se tocan.
const versionCargo = (texto) => {
  const re = /^version = "[^"]*"$/m;
  if (!re.test(texto)) throw new Error('no se encontró la versión del paquete');
  return texto.replace(re, `version = "${version}"`);
};

console.log(`Sincronizando versión ${version}`);
editar('package.json', versionJson);
editar('src-tauri/tauri.conf.json', versionJson);
editar('src-tauri/Cargo.toml', versionCargo);
