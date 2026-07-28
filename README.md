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

### Sincronizar entre equipos

La nota es el fichero; `workspace.db` es una caché que se rehace sola al
arrancar leyendo `notas/`. Por eso el workspace se puede sincronizar con **git,
Syncthing o un pendrive** sin nada más:

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
