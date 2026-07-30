# Nota Local

Un "Notion" local, rápido y sin servidor. **Angular 20 + Tauri (Rust) + SQLite.**

```
        ┌──────────────────┐
        │   Angular 20      │   UI, editor, signals, RxJS
        └────────┬─────────┘
                 │  IPC  invoke()
        ┌────────▼─────────┐
        │   Rust (Tauri)   │   comandos, ficheros, OCR/IA (futuro)
        ├──────────────────┤
        │ SQLite (rusqlite)│   workspace.db
        └──────────────────┘
```

No hay REST, ni HTTP, ni Tomcat, ni CORS. El frontend llama a funciones Rust
directamente: `invoke("guardar_documento", { documento })`.

## Requisitos

- **Node 22** (fijado en `.nvmrc`). Con nvm: `nvm use`.
- **Rust** (rustup) — instalado en `~/.cargo`.
- **Librerías de sistema (Ubuntu 24.04)** — una sola vez:

  ```bash
  sudo apt update && sudo apt install -y \
    libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```

## Arrancar en desarrollo

```bash
nvm use            # Node 22
npm install        # (solo la primera vez)
npm run tauri:dev  # levanta ng serve + la ventana Tauri
```

> La **primera** compilación de Rust (webkit + tauri + sqlite) tarda varios
> minutos; las siguientes son incrementales y rápidas.

## Compilar release

```bash
npm run tauri:build   # binario/instalador en src-tauri/target/release
```

## Estructura

```
nota-local/
├─ src/                                # Angular
│  └─ app/
│     ├─ core/documentos.service.ts    # puente invoke() ➜ Rust
│     ├─ models/documento.model.ts
│     ├─ app.ts / app.html / app.scss  # demo: crear/listar/borrar documentos
│     └─ app.config.ts
├─ src-tauri/                          # Rust
│  └─ src/
│     ├─ lib.rs                        # setup, estado, registro de comandos
│     ├─ commands.rs                   # #[tauri::command] (la "API")
│     ├─ db.rs                         # conexión + esquema + CRUD SQLite
│     └─ models.rs                     # Documento, DocumentoResumen
└─ dist/nota-local/browser/            # build de Angular (frontendDist de Tauri)
```

## Workspace (datos del usuario)

Se crea automáticamente al arrancar, dentro del `app_data_dir` del sistema:

```
<app_data_dir>/Workspace/
├─ notas/<id>.json  # UNA nota por fichero — la fuente de verdad
├─ assets/          # imágenes, pdfs, vídeos (nombre = sha256 del contenido)
├─ workspace.db     # SQLite: índice DERIVADO (listado, etiquetas, FTS5)
├─ .gitignore       # excluye workspace.db y las miniaturas
├─ backups/
└─ export/
```

En Linux: `~/.local/share/net.adcomp.notalocal/Workspace/`.

### Bóvedas

Puede haber **varias bóvedas** y se cambia entre ellas desde el nombre, arriba en
la barra lateral. Cada una es una carpeta independiente **con su propio
repositorio**, así que la personal va a tu repo privado y una compartida al de
otra persona (que te añade como colaborador en GitHub).

La bóveda original se queda en `Workspace/`; las nuevas van a `Bovedas/<nombre>/`.
El registro (`bovedas.json`) vive fuera de las bóvedas: es de este equipo y no se
sincroniza.

Para conectar una bóveda compartida: créala vacía desde el selector y luego
⚙ Ajustes → *Conectar con uno existente*.

#### Compartir: siempre en solo lectura

Lo decide **de quién es el repositorio**:

| Bóveda | Qué puedes hacer |
|---|---|
| Tu cuaderno en **otro equipo tuyo** | Editar con normalidad |
| Un cuaderno que **te comparten** | Solo leer |

Basta con añadir a la otra persona como colaborador del repo (privado) en
github.com. Aunque GitHub le dé permiso de escritura —en repos personales se lo
da a todos—, la app abre esa bóveda **en solo lectura**: sin crear, editar ni
borrar, y sin subir nunca nada. Se sincroniza como un espejo.

Ese veto lo aplica el backend en Rust, en cada comando de escritura; ocultar los
botones es solo cortesía de la interfaz.

#### Cuaderno de equipo con hojas protegidas

Si añades a alguien como colaborador, puede crear, editar y borrar notas en esa
bóveda. Las que tú marques con el **candado** solo podrá leerlas.

| | Notas normales | Notas con candado |
|---|---|---|
| **Tú** (dueño del repo) | Todo | Todo, y pones/quitas el candado |
| **Colaborador** | Crear, editar, borrar | Solo leer |

**El candado es una barandilla, no un permiso.** Quien tiene acceso de escritura
al repositorio puede editar el fichero fuera de la app y subirlo; git no sabe
nada del candado. Lo que sí ocurre es que **tu copia lo revierte**: al
sincronizar, tu app detecta que una nota bloqueada llegó cambiada, restaura la
tuya y guarda la ajena al lado como `<id>.conflicto-<fecha>.json`. Sirve para
trabajar en equipo de buena fe, no para defenderte de alguien.

### Sincronizar entre equipos

Lo normal es hacerlo desde la app: **⚙ Ajustes → Cuenta y sincronización**.

1. **Iniciar sesión con GitHub** — sale un código, lo apruebas en el navegador.
2. En el equipo que **ya tiene tus notas**: *Crear un repositorio*. Siempre se
   crea **privado** — no es configurable, a propósito.
3. En los **demás equipos**: *Conectar con uno existente* y elegirlo de la lista.

A partir de ahí se sincroniza sola: trae cambios al abrir la app y sube poco
después de cada edición. Si el segundo equipo ya tenía notas escritas, no se
pierden — se fusionan (los ficheros van por UUID y no pueden chocar).

Si la misma nota se editó en dos equipos a la vez, gana la más reciente y la otra
versión se guarda al lado como `<id>.conflicto-<fecha>.json`. Nunca se descarta
nada.

> La OAuth App ya está registrada y su Client ID va en el binario: **el usuario no
> tiene que configurar nada**, solo iniciar sesión con su propia cuenta. Para
> compilar contra otra OAuth App, exporta `NOTA_LOCAL_CLIENT_ID`.
>
> Ojo: esto sube tus notas a GitHub. El repositorio es privado, pero GitHub puede
> leerlo. La misma pantalla sirve para un Gitea auto-hospedado cambiando la URL.

#### A mano, sin la app

La nota es el fichero y `workspace.db` es una caché que se rehace sola, así que
el workspace también se sincroniza con **git, Syncthing o un pendrive** sin
pasar por la interfaz:

```bash
cd ~/.local/share/net.adcomp.notalocal/Workspace
git init && git add -A && git commit -m "notas"
git remote add origin <tu-repo> && git push -u origin main
```

En el otro equipo, `git pull`. Con la app abierta, `invoke('recargar_workspace')`
relee el disco sin reiniciar.

**No metas `workspace.db` en la sincronización** (el `.gitignore` ya lo excluye):
SQLite escribe en varios pasos no atómicos, así que copiarlo a media escritura lo
parte, y un conflicto te obliga a elegir un lado perdiendo **todas** las notas del
otro. Con un fichero por nota el conflicto es de una nota, y borrar una nota es
borrar un fichero (el borrado viaja solo, sin tabla de lápidas).

## Bloques cifrados

Con `/` → **Bloque cifrado** puedes guardar una contraseña o una cadena de
conexión dentro de una nota normal. Solo se cifra ese valor: la nota sigue siendo
JSON legible, así que los diffs de git, la fusión y la búsqueda siguen igual.

La primera vez se pide una **contraseña maestra** para la bóveda. Necesitarás la
misma en tus otros equipos; **si la olvidas, esos bloques se pierden** (no hay
recuperación posible). La clave se cierra sola a los 5 minutos sin usarla.

El valor no pasa nunca por el documento en claro: se escribe en un diálogo, lo
cifra Rust y en la nota solo queda `v1.<base64>`.

La contraseña **no se guarda en ningún sitio**. En la bóveda queda solo
`secretos.json` con la sal y un verificador (ninguno es secreto); la clave
derivada vive en memoria y se borra a los 5 minutos o al cerrar la app.

### Recuperar los secretos sin la app

`herramientas/recuperar/` saca los bloques cifrados de una bóveda usando solo
librerías públicas, sin depender de nada del proyecto:

```bash
cd herramientas/recuperar
cargo run -- ~/.local/share/net.adcomp.notalocal/Workspace "tu contraseña maestra"
```

El formato está anotado dentro de cada `secretos.json` (`kdf`, `cifrado`,
`formato`), para poder rehacerlo en cualquier lenguaje aunque este repositorio
desaparezca. Que el algoritmo sea público no debilita nada: toda la seguridad
está en la contraseña.

### Cambiar la contraseña maestra

⚙ Ajustes → Secretos. Recifra todos los bloques con la clave nueva.

Ojo con lo que esto consigue: **no le quita a nadie lo que ya vio**, ni el clon
del repositorio que pueda tener con el cifrado viejo. Si alguien deja el equipo,
el orden es:

1. Quitarle el acceso al repositorio en GitHub.
2. **Cambiar las credenciales de verdad** (la contraseña real de la base de
   datos, el token real). Esto es lo que lo deja fuera.
3. Rotar la contraseña maestra y pasarle la nueva al resto del equipo.

Rotar sin el paso 2 no sirve de nada.

### Si te quitan el acceso a una bóveda

La app lo detecta al sincronizar y te lo dice: la bóveda deja de sincronizarse y
sus bloques cifrados no se abren. **No se borra sola** — puede tener notas que
escribiste tú, así que quitarla es decisión tuya («Quitar bóveda» deja los
ficheros en el disco). Si te vuelven a invitar, «Volver a comprobar» la reactiva.

## Modelo de datos

El contenido del documento se guarda como **JSON de bloques** (no HTML, no
Markdown) en la columna `document.contenido`:

```json
{
  "id": "…",
  "titulo": "Proyecto",
  "contenido": [
    { "type": "heading", "text": "Backend" },
    { "type": "paragraph", "text": "Hoy terminé…" },
    { "type": "image", "asset": "5f3ad3.png" }
  ]
}
```

## Comandos Rust disponibles

| Comando               | Angular                                          |
|-----------------------|--------------------------------------------------|
| `guardar_documento`   | `docs.guardar(documento)` — inserta o actualiza  |
| `obtener_documento`   | `docs.obtener(id)`                               |
| `listar_documentos`   | `docs.listar()`                                  |
| `eliminar_documento`  | `docs.eliminar(id)`                              |

## Siguientes pasos

- **Editor de bloques** (BlockNote vía `@dytab/ngx-blocknote`, o Tiptap).
- Gestión de `assets` (guardar ficheros + hash + thumbnails) desde Rust.
- Búsqueda full-text (FTS5, ya incluido en el SQLite bundled).
- Etiquetas (`tag` / `document_tag`) e IA/OCR local.
