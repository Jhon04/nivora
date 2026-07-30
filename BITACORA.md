# Bitácora — Nota Local

Un "Notion" local, rápido y sin servidor. **Angular 20 + Tauri (Rust) + SQLite.**

> Última actualización: 2026-07-28

---

## 1. Resumen del estado

Aplicación de escritorio funcional con un editor de bloques tipo Notion. El
frontend (Angular) habla con el backend (Rust) por IPC (`invoke`), sin REST ni
HTTP. Cada documento es un fichero **`notas/<id>.json`** (JSON de Tiptap indentado) y las
imágenes son ficheros en `assets/` con nombre de hash; **SQLite es un índice derivado** que se
reconstruye a partir de ellos. Así el workspace se sincroniza entre equipos con git o Syncthing.

```
        ┌──────────────────┐
        │   Angular 20      │   UI, editor Tiptap, signals
        └────────┬─────────┘
                 │  IPC  invoke()
        ┌────────▼─────────┐
        │   Rust (Tauri)   │   comandos, ficheros, SQLite
        ├──────────────────┤
        │ SQLite (rusqlite)│   workspace.db
        └──────────────────┘
```

---

## 2. Entorno / stack

| Componente | Versión / nota |
|---|---|
| Node | **22 LTS** vía nvm (`.nvmrc`), aislado — el Node 18 global del sistema no se toca |
| Angular | **20.3** + Angular Material 20.2 (tema azure-blue) + signals |
| Editor | **Tiptap 3.28.0** montado a mano con `ngx-tiptap` v14 (todo clavado en 3.28.0) |
| Tauri | **v2** (CLI 2.11), Rust 1.97 |
| Base de datos | **SQLite** vía `rusqlite` (feature `bundled` → compila SQLite, sin libsqlite del sistema) |

**Requisito de sistema (Ubuntu 24.04, una vez):**
```bash
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
```

**Arrancar:**
```bash
nvm use && npm run tauri:dev
```

---

## 3. Estructura del proyecto

```
nota-local/
├─ src/app/
│  ├─ app.ts / app.html / app.scss     # shell: sidebar + panel; TOOLBAR sticky arriba
│  ├─ core/
│  │  ├─ documentos.service.ts          # invoke() de documentos
│  │  └─ assets.service.ts              # invoke() de assets (guardar/importar)
│  ├─ models/documento.model.ts         # Documento, DocumentoResumen
│  ├─ shared/
│  │  └─ configuracion.ts/.html/.scss   # ⚙ Ajustes: cuenta GitHub, tema, workspace
│  └─ editor/
│     ├─ editor.ts / .html / .scss      # componente editor Tiptap
│     ├─ slash-command.ts               # menú "/" (@tiptap/suggestion)
│     ├─ block-drag.ts                  # reordenar bloques (eventos de puntero)
│     ├─ asset-image.ts                 # imagen: ruta local → convertFileSrc
│     ├─ anotar-imagen.ts / .html/.scss # pantalla de edición al insertar imagen
│     └─ formas.ts                      # geometría de las formas (sin UI, testeable)
├─ src-tauri/src/
│  ├─ lib.rs                            # setup, estado, plugins, comandos
│  ├─ commands.rs                       # #[tauri::command] (la "API")
│  ├─ bovedas.rs                        # registro de bóvedas y cuál está abierta
│  ├─ almacen.rs                        # notas/<id>.json: la FUENTE DE VERDAD
│  ├─ sincro.rs                         # git embebido: commit, push, fetch, conflictos
│  ├─ github.rs                         # device flow, crear repo, token al llavero
│  ├─ db.rs                             # SQLite: índice derivado (listado, tags, FTS5)
│  └─ models.rs                         # Documento, DocumentoResumen, AssetGuardado
└─ dist/nota-local/browser/             # build de Angular (frontendDist de Tauri)
```

**Workspace de datos:** `~/.local/share/net.adcomp.notalocal/Workspace/`
(`notas/<id>.json` + `assets/` + `workspace.db` + `.gitignore` + `backups/ export/`).
Las notas y los assets son la verdad; `workspace.db` se reconstruye a partir de ellos, así
que la carpeta se puede sincronizar entre equipos con git o Syncthing. Ver 4.23.

**Tablas SQLite (todas derivadas):** `document`, `tag`, `document_tag`, `asset`.

**Comandos Rust.** Documentos: `guardar_documento`, `obtener_documento`, `listar_documentos`,
`eliminar_documento`, `buscar_documentos`, `listar_etiquetas`, `recargar_workspace` (relee
`notas/` tras un `git pull`).
Assets: `guardar_asset` (bytes base64), `importar_asset` (desde ruta), `leer_imagen` (base64 sin
guardar: para editar la imagen antes de insertarla).
Cuenta y sincronización: `github_sesion`, `github_iniciar_sesion`, `github_esperar_aprobacion`,
`github_cerrar_sesion`, `github_listar_repos`, `crear_repo`, `conectar_repo`, `sincronizar`,
`estado_sincro`, `desconectar_repo`.
Bóvedas: `listar_bovedas`, `boveda_activa`, `crear_boveda`, `cambiar_boveda`, `olvidar_boveda`,
`renombrar_boveda`.

---

## 4. Lo realizado en esta sesión

### 4.1 Entorno base
- Instalado Node 22 (nvm), Rust (rustup), Tauri CLI, Angular 20 + Material.
- Scaffold Tauri v2 + Angular; backend Rust con SQLite (rusqlite bundled).
- Demo funcional del flujo Angular → Rust → SQLite (crear/listar/borrar).

### 4.2 Editor Tiptap
- Componente `editor/` con StarterKit + Placeholder + TaskList/TaskItem.
- App refactorizada a **2 paneles** (lista de documentos + editor) con guardar/cargar.
- Guard `ultimoEmitido` para no reiniciar el cursor con el propio eco de la edición.

### 4.3 Bubble menu
- Menú flotante al seleccionar texto (negrita, cursiva, títulos, listas, etc.).

### 4.4 Slash menu `/`
- `slash-command.ts` sobre `@tiptap/suggestion`; popup renderizado con **signals** de Angular.
- 10 bloques, filtrado por texto/keywords, navegación teclado (↑↓ Enter Esc) y ratón.

### 4.5 Drag handle ⠿ (reordenar bloques)
- **Gotcha:** el drag & drop nativo de HTML5 **NO funciona en WebKitGTK** (webview de
  Tauri en Linux; bug tauri#6695), ni con `dragDropEnabled:false`.
- Se descartó `@tiptap/extension-drag-handle` (usa DnD nativo) y se implementó
  `block-drag.ts` con **eventos de puntero** (mousedown/move/up): handle ⠿, cálculo de
  bloque con `posAtCoords`, movimiento con transacción `delete`+`insert`.
- **Reordenar dentro de listas (4.13):** `blockAt` ahora busca el `listItem`/`taskItem`
  más profundo bajo el cursor (reordena ítems, incluso anidados); si no hay lista, el bloque
  de nivel superior. `dropTarget`/`moveBlock` validan con `parent.canReplaceWith(...)` que el
  nodo origen encaja en el destino → solo permite movimientos válidos (misma lista o entre
  bloques top-level), nunca corrompe el doc. El indicador se **alinea/indenta** al ítem destino.

### 4.6 Imágenes
- **Pegar (Ctrl+V)** cubre 3 casos: bytes de imagen (captura), files con bytes, y
  **ruta/URI** (copiar fichero desde el explorador → se pega la ruta, no los bytes).
- **Botón "Insertar"** que abre el diálogo nativo (`@tauri-apps/plugin-dialog`).
- Rust guarda en `assets/<sha256>.<ext>` (dedup por hash) y registra en tabla `asset`.
- `AssetImage` (extensión propia) convierte la ruta local a URL del webview con
  `convertFileSrc`; el documento guarda la **ruta**, no la URL ni la imagen embebida.
- Requiere: `assetProtocol` en tauri.conf.json (`$APPDATA/**`) + feature `protocol-asset`.

### 4.30 Pérdida de acceso a una bóveda compartida
- Cuando el dueño saca a alguien del repositorio, su app **lo detecta, lo dice y deja de
  sincronizar** — pero **no borra la bóveda**. Se pidió el borrado automático y se descartó a
  propósito: (a) no protege nada, porque el clon ya está en su disco y basta con no abrir la app
  o copiar la carpeta antes; (b) GitHub devuelve **404** para un repo privado sin acceso, el
  mismo código que si lo borraron o renombraron, así que un fallo de red podría destruir datos;
  (c) una bóveda compartida contiene **notas que escribió esa persona**; y (d) borrar ficheros
  del equipo de alguien porque un tercero pulsó algo en GitHub es una puerta trasera.
- **La detección no se fía de git, pregunta a la API.** Si la operación de git falla, se consulta
  `GET /repos/{owner}/{repo}`: un 404 con la sesión viva es la señal inequívoca de que te sacaron;
  cualquier otro fallo (`FalloRepo::NoSeSabe`) no toca la marca. Sin esa distinción, un wifi malo
  marcaría bóvedas como perdidas.
- Con `sin_acceso` puesta: no se reintenta en cada guardado (antes daría el mismo error para
  siempre sin explicar nada), banda roja con el motivo, y dos botones — **Volver a comprobar**
  (`comprobar_acceso`, para cuando te vuelven a invitar) y **Quitar bóveda**, que usa el
  `olvidar_boveda` que ya existía y **no borra los ficheros**.
- **Los bloques cifrados dejan de abrirse** en una bóveda sin acceso (`exigir_acceso` en
  `cifrar_secreto`/`descifrar_secreto`/`desbloquear_secretos`) y el candado se cierra en el
  momento de detectarlo. **Es una barandilla, no una garantía**: el cifrado y la sal siguen en su
  disco, así que con la contraseña maestra se descifran fuera de la app. Lo que de verdad deja
  fuera a quien salió es que el dueño **rote la contraseña** (4.29).
- 4 tests de Angular, incluido uno que comprueba que la bóveda **no** se borra sola.

### 4.29 Bloques cifrados dentro de la nota
- **No se cifra la bóveda ni la nota, solo el valor de los bloques `secreto`** (contraseñas,
  cadenas de conexión, credenciales). Analizado antes de decidir: cifrar el fichero entero
  rompía los diffs de git (era la razón de elegir JSON indentado, +2/−2 medido), la fusión por
  fecha (que lee `modificado` sin descifrar), la deduplicación de assets por hash, y convertía
  perder la contraseña en perder el cuaderno. Así el coste es opt-in y acotado.
- **GOTCHA que define el diseño — el texto en claro NUNCA entra en el documento.** Si el bloque
  fuera texto editable y se cifrara «al guardar», el autoguardado ya habría escrito la contraseña
  en claro en disco **y en un commit**, y git no olvida. Por eso el nodo es un `atom`: el valor se
  teclea en un diálogo, se cifra en Rust y al documento solo llega el resultado.
- **El índice FTS nunca contiene el secreto**, y sale gratis: el cifrado viaja en `attrs`, no en
  un nodo de texto, y `db::extraer_texto` solo recoge claves `text`. La etiqueta sí es texto
  normal, para poder buscarla y saber qué es sin abrir el bloque.
- **XChaCha20-Poly1305** con nonce aleatorio por bloque (cifrar dos veces el mismo valor da
  resultados distintos: no se puede deducir que dos secretos son iguales) y clave derivada con
  **Argon2id**. Formato `v1.<base64(nonce||sellado)>`, versionado para poder cambiar de algoritmo.
- **Contraseña maestra, no clave en el llavero**: la misma bóveda se abre en varios equipos y la
  clave no puede viajar en el repositorio. La sal va en `secretos.json` **dentro** de la bóveda y
  se versiona (las sales no son secretas), junto a un verificador que permite decir «contraseña
  incorrecta» al desbloquear en vez de fallar al abrir un bloque, donde parecería corrupción.
- **La clave vive en memoria y se cierra sola a los 5 minutos** sin usarse; cada uso legítimo
  refresca el reloj, para no pedir la contraseña a mitad de faena. Nunca pasa por el webview:
  Angular manda el texto y recibe el cifrado, como con el token de GitHub.
- El bloque sale **enmascarado siempre** (abrir una nota no puede destapar credenciales solas),
  con ojo para revelar —se vuelve a tapar a los 20 s— y botón de copiar sin enseñarlo, que es el
  uso habitual.
- **Lo que sigue costando:** si se olvida la contraseña esos bloques se pierden (sin reset
  posible); en una bóveda compartida, quien la tenga ve todos los secretos; y fuera de la app
  son ilegibles.
- **Mínimo de 12 caracteres** (era 8, poco) y el texto sugiere una **frase de varias palabras**:
  la sal y el verificador viajan en el repositorio, así que se puede atacar sin conexión y a su
  ritmo. Argon2id (m=19 MiB, t=2, p=1 — los de OWASP) encarece cada intento a ~50-100 ms, pero
  eso solo compra tiempo; lo que protege es la longitud.
- **Rotar la contraseña maestra** (⚙ Ajustes → Secretos): recifra todos los bloques con una clave
  nueva. `Secretos::rotar` **descifra todo primero y solo escribe si nada falla** — si fuera
  guardando sobre la marcha y fallara a mitad, la bóveda quedaría con unos bloques bajo la clave
  vieja y otros bajo la nueva, rota sin arreglo. Solo devuelve las notas que de verdad cambian,
  para no ensuciar el diff ni la fecha de notas sin secretos.
- **Lo que rotar NO consigue, dicho en la propia pantalla:** no le quita a nadie lo que ya vio, ni
  el clon del repositorio con el cifrado viejo. Cuando alguien deja el equipo el orden es: quitarle
  el acceso en GitHub → **cambiar las credenciales de verdad** → rotar. Sin el paso del medio,
  rotar no sirve de nada, y era fácil creer lo contrario.
- **`secretos.json` se describe a sí mismo**: además de la sal y el verificador, anota `kdf`,
  `kdfParametros`, `cifrado` y `formato`. El algoritmo **no es un secreto y no debe serlo**
  (Kerckhoffs: la seguridad está en la contraseña; ocultarlo sería inútil —un `strings` sobre el
  binario lo canta— y encima dejaría los datos irrecuperables). El problema real no es el
  atacante, es **tu yo de dentro de tres años** mirando un `version: 1` que no dice nada. Las
  bóvedas anteriores se anotan solas al abrirlas.
- **`herramientas/recuperar/`**: programa independiente (~60 líneas, solo librerías públicas de
  crates.io, ni una del proyecto) que saca los secretos de una bóveda sin la app. Probado contra
  una bóveda generada por el código real: recupera los valores y rechaza la contraseña
  equivocada. Es la vía de recuperación, y de paso demuestra por qué bloquear el descifrado en la
  app es una barandilla y no una garantía.
- 18 tests de Rust: ida y vuelta, que el claro no aparece en lo guardado, nonces distintos, otro
  equipo con la misma contraseña, contraseña incorrecta, bloqueo, cierre por inactividad,
  refresco del reloj y bloque manipulado (el cifrado está autenticado: falla en vez de devolver
  basura), y de la rotación: recifrado completo, la contraseña vieja deja de abrir, no toca notas
  sin secretos, y —lo crítico— con la contraseña actual equivocada o un bloque corrupto **no se
  escribe nada**. Más 5 de Angular sobre la pantalla de cambio.

### 4.28 Notas bloqueadas: bóveda de equipo con hojas protegidas
- Cada nota gana `bloqueada` (`#[serde(default)]`, las notas viejas abren igual). **El dueño de
  la bóveda** edita todo y pone/quita el candado; **los colaboradores** crean, editan y borran
  todo salvo lo bloqueado, que solo leen. Botón de candado en la barra del documento (solo lo ve
  el dueño) e icono en el listado.
- **Reabre las bóvedas compartidas a la edición** (4.27 las cerraba enteras). Decisión explícita:
  lo que se quería era un cuaderno de equipo con partes protegidas.
- **Es una barandilla, no un permiso, y hay que decirlo:** la marca vive dentro de un fichero de
  un repositorio donde el colaborador tiene escritura, así que puede saltársela editando fuera de
  la app. Lo que la hace sólida es la **restauración**: el dueño toma una instantánea de sus notas
  bloqueadas antes de traer cambios (`instantanea_bloqueadas`) y, si alguna llegó cambiada o
  borrada, `restaurar_bloqueadas` devuelve la suya, guarda la ajena como
  `<id>.conflicto-<fecha>.json` y lo confirma como un cambio más. La manipulación no se mantiene.
- **La marca que vale es la del disco, no la del webview**: `guardar_documento` lee la nota
  guardada para decidir, y si no eres el dueño conserva el `bloqueada` almacenado. Mandar
  `bloqueada: false` a mano no desbloquea nada.
- **GOTCHA — el índice no se recrea, solo se vacía.** `CREATE TABLE IF NOT EXISTS` no toca una
  tabla existente, así que una base de una versión anterior se habría quedado sin la columna
  `bloqueada` y **todas las consultas fallarían al arrancar**. `migrar_columnas()` la añade con
  `ALTER TABLE`; hay un test que abre una base con el esquema viejo.
- `soy_dueno` en la bóveda sale de comparar `repo.owner.login` con tu cuenta (`github::es_mio`),
  no del permiso de GitHub: en un repo privado personal todos los colaboradores pueden empujar,
  así que por ahí no se distingue al dueño.
- **Aviso visible al restaurar**: banda ámbar en la zona principal (no solo en Ajustes, que
  habría que ir a buscar) nombrando **el título** de cada nota tocada — un UUID no le dice nada
  al usuario — y descartable. `restauradas` viaja aparte de `conflictos` en `ResultadoSincro`:
  un conflicto es que dos personas editaron a la vez; esto es que alguien tocó lo que no debía, y
  merecen mensajes distintos. Se acumulan sin repetir por id, y se limpian al cambiar de bóveda.
- 5 tests de Rust (restauración de nota cambiada y borrada, las no bloqueadas no se tocan,
  migración del índice) + 9 de Angular (regla por nota y aviso).

### 4.27 Solo lectura por PROPIEDAD, impuesto en Rust
- **Cambia el criterio**: ya no se mira `permissions.push` de GitHub, sino **quién es el dueño
  del repositorio** (`github::puede_escribir`). El motivo es que en un repositorio **privado
  personal GitHub le da escritura a TODO colaborador**: mirando solo el permiso, un cuaderno
  compartido llegaba editable — y borrable — al que lo recibe.
- Con la regla nueva los dos casos salen solos y sin configurar nada:
  - tu cuaderno en **otro equipo tuyo** → eres el dueño → editas;
  - un cuaderno que **te comparten** → no eres el dueño → solo lectura, nunca push ni borrado.
  Se sigue exigiendo además `escritura`, para el caso de una organización con rol *Read*.
- **El veto lo aplica Rust, no la plantilla** (`commands::exigir_escritura`): `guardar_documento`,
  `eliminar_documento`, `guardar_asset` e `importar_asset` fallan si la bóveda activa está
  marcada. El webview es la parte fácil de saltarse (un atajo que se escape, un `invoke` desde la
  consola, un fallo de la propia UI); quien decide si se toca el disco es el backend. Angular
  sigue ocultando los controles, pero eso es cortesía, no la defensa.
- La sincronización de estas bóvedas ya era espejo (`fetch` + `reset`, sin commit ni push): así
  "nunca hace push ni delete" se cumple también en el lado de git.
- *Consecuencia asumida:* **no hay cuadernos compartidos editables**. Un equipo que quisiera
  escribir a varias manos en la misma bóveda ya no puede; era el precio de que compartir sea
  seguro por defecto con repos privados personales.
- 6 tests nuevos en `github.rs` (la regla de propiedad, mayúsculas incluidas) y 1 en `bovedas.rs`.

### 4.26 Bóvedas de solo lectura (compartir sin dar escritura)
- **GitHub NO permite colaboradores de solo lectura en repositorios personales**: ahí solo hay
  dueño y colaboradores, y todo colaborador escribe. El selector de rol (Read/Write/…) existe
  únicamente en repos de **organización**. Para compartir sin dar escritura hay que poner la
  bóveda en una organización (gratis) y añadir a la otra persona con rol **Read**, o hacer el
  repo público. Está en el README, porque no es evidente y condiciona todo el diseño.
- **La app no inventa un "modo compartido": refleja el permiso real.** Al conectar se consulta
  `GET /repos/{owner}/{repo}` y se guarda `permissions.push` en la bóveda (`soloLectura`). El
  usuario en su propio segundo equipo es dueño → escribe; un colaborador Read → solo lee. Es la
  misma distinción que ya hace GitHub, sin estado paralelo que se pueda desincronizar.
- **Sin bloque `permissions` se asume SOLO LECTURA**: es el lado seguro — como mucho la bóveda se
  abre bloqueada y el usuario lo ve, en vez de intentar subir y fallar en cada guardado.
- **Sincronización en modo espejo** (`sincro::espejar`): `fetch` + `reset --hard`, sin confirmar
  ni empujar. Fusionar aquí generaría conflictos en cada sincronización que el usuario **no
  podría resolver nunca**, porque no tiene permiso para subir su versión. Descarta, no fusiona —
  y por eso la UI tiene que impedir editar de verdad.
- **Auto-degradación**: si un push se rechaza por permisos (`es_falta_de_permiso`), la bóveda pasa
  a solo lectura sola. Cubre que el dueño se los quite después de haberla conectado.
- **Bloqueo en tres capas**, porque una sola no basta:
  1. `editor.setEditable(false)` — apaga ProseMirror. Ocultar botones no serviría: el teclado, el
     pegado y el menú «/» seguirían editando.
  2. Plantilla: sin «Nuevo», sin borrar, sin icono/portada/etiquetas, título en `readonly`.
  3. `programarGuardado()` **y** `guardarAuto()` cortan si la bóveda es de solo lectura. Son dos
     comprobaciones porque `flushGuardado()` llama a la segunda directamente.
- El modo es **por bóveda**: que un cuaderno compartido esté bloqueado no puede contagiar a las
  notas propias. Hay test de ida y vuelta.
- Distintivo de ojo en el selector y en la lista; aviso en la barra lateral.
- 2 tests de Rust en `github.rs`, 2 en `bovedas.rs` y 4 en Angular.

### 4.25 Bóvedas: varios workspaces con selector
- **Una bóveda = una carpeta autónoma** (notas + assets + índice + **su propio repositorio**).
  `src-tauri/src/bovedas.rs` + `core/bovedas.service.ts`. Selector en la cabecera de la barra
  lateral: el nombre de la bóveda sustituye al título fijo "Nota Local".
- **Por qué:** compartir dejaba de ser todo o nada. La bóveda personal apunta al repositorio
  privado del usuario y una compartida al de otra persona (como colaborador). Además reduce los
  conflictos: si en la común solo está lo común, se choca mucho menos.
- **Registro** en `<app_data_dir>/bovedas.json`, **nunca dentro de una bóveda**: es de este
  equipo y no debe viajar por git.
- **La bóveda original NO se mueve.** Al arrancar por primera vez se adopta el `Workspace/` que
  ya existía como "Mis notas", en su sitio. Mover las notas del usuario solo para que el árbol
  quedara simétrico sería arriesgar datos a cambio de nada. Verificado sobre el workspace real.
- `Db` y `Almacen` dejan de ser estados de Tauri independientes: viven dentro de `Bovedas`, tras
  un `Mutex`, para poder **sustituirse** al cambiar. `db()`/`almacen()` devuelven un `Arc`
  clonado y sueltan el candado en el acto (los comandos de sincronización son `async` y un
  `MutexGuard` no puede cruzar un `await`).
- **`lib.rs` adelgaza**: la secuencia de arranque se muda a `bovedas::abrir()`, porque cambiar de
  bóveda la repite entera y no podía quedarse solo en el arranque.
- **Rutas fijas eliminadas**: 4 en Rust (`join("Workspace")`) y **una en Angular**,
  `assets.service.ts`, que componía `appDataDir() + 'Workspace' + 'assets'`. Esa era la
  peligrosa: una imagen pegada en la bóveda compartida se habría escrito en la personal y la
  nota apuntaría a un fichero que los demás nunca reciben. Ahora la ruta la da Rust.
- **El cambio de bóveda tiene un orden obligatorio** (`App.cambiarBoveda`), con test para cada
  paso: (1) vaciar el guardado pendiente — el autoguardado va con temporizador y si salta después
  escribiría en la bóveda equivocada; (2) cambiar en Rust; (3) **cerrar el documento abierto** —
  es de la bóveda anterior y seguir escribiendo lo guardaría como nota nueva en la de destino;
  (4) rehacer la base de assets. También se limpian búsqueda y filtro, que apuntaban a notas que
  aquí no existen.
- `cambiar()` abre la bóveda nueva **antes** de tocar el estado: si la carpeta ha desaparecido
  (una compartida en un disco desconectado), te quedas en la que estabas en vez de sin ninguna.
- `olvidar()` **no borra ficheros** (una bóveda compartida sigue viva en el repositorio de otra
  persona) y no deja quedarse sin ninguna. `renombrar()` no mueve la carpeta.
- Nombres repetidos → carpetas distintas (`equipo`, `equipo-2`): si compartieran ruta, las notas
  de una aparecerían en la otra.
- **GOTCHA — ámbitos de `@if`**: en Angular 17+ cada bloque de control de flujo es un ámbito
  propio, así que el `ng-template` del overlay tiene que estar **dentro del mismo `@if`** que el
  `#origenBovedas` al que se ancla.
- La pantalla de Ajustes dice ahora a qué bóveda se refiere la sincronización; sin eso es fácil
  creer que la cuenta de GitHub vale para todas.
- 11 tests de Rust + 8 de Angular sobre el orden del cambio.

### 4.24 Configuración: cuenta de GitHub y sincronización automática
- Botón **⚙ Ajustes** en el pie de la barra lateral → diálogo con 3 secciones (cuenta y
  sincronización, apariencia, workspace). `shared/configuracion.ts/.html/.scss`.
- **Device Flow, no OAuth web**: el OAuth clásico necesita un `client_secret` y en una app que
  la gente se descarga **no hay dónde guardar un secreto**. Con device flow el usuario teclea un
  código en `github.com/login/device` — sin servidor propio, sin redirección a localhost, sin
  navegador embebido. Es lo que hace `gh auth login`. Requiere registrar una OAuth App y marcar
  **Enable Device Flow**; el Client ID va en `github.rs` (es público) o en `NOTA_LOCAL_CLIENT_ID`.
- **Ámbito pedido: solo `repo`.** Nada de `user`, `workflow` ni `delete_repo`.
- **El repositorio se crea SIEMPRE privado y no es configurable.** Antes era una casilla marcada
  por defecto; se quitó porque era el único control de la app donde un clic distraído publica las
  notas en internet abierto, y eso **no se deshace** (GitHub cachea, los buscadores indexan,
  alguien pudo hacer un fork). Los repos privados son gratis e ilimitados, así que la opción solo
  aportaba riesgo. `cuerpo_repo()` está separada de la llamada de red para poder comprobarlo en un
  test: si un refactor lo pusiera en `false`, no se notaría hasta que fuera tarde.
  *Consecuencia asumida:* ya no se puede crear desde la app un repo público para compartir en
  solo lectura sin organización. Conectar con uno público creado en github.com sigue funcionando.
- **El token nunca pasa por el webview**: todas las llamadas salen de Rust y Angular solo sabe
  quién ha iniciado sesión. Se guarda en el **llavero del sistema** (`keyring`); si no hay
  Secret Service, cae a un fichero 0600 en el directorio de datos — **jamás en `Workspace/`**,
  que se subiría al repo en el primer commit (hay un test que lo vigila).
- **DOS botones, no uno** (el hueco del diseño original): *Crear repositorio* sirve al primer
  equipo, el que ya tiene notas; el segundo equipo necesita *Conectar con uno existente*. Con
  solo el primero, el usuario que estrena su PC se queda atascado o crea un repo vacío y parte
  sus notas en dos.
- **Si el segundo equipo ya tenía notas, no se pierden**: se fusionan historias sin ancestro
  común, y como los ficheros van por UUID **no pueden chocar**. Hay test.
- **git embebido (`git2`/libgit2), no el `git` del sistema**: un portátil recién estrenado con
  Windows o macOS no lo trae y el primer paso del usuario no puede ser abrir una terminal.
- **Orden obligatorio `confirmar → traer → empujar`** (`sincro.rs`): confirmar primero deja el
  árbol limpio y a partir de ahí git solo mueve commits. Al revés, un `checkout` se llevaría por
  delante lo que el usuario acabara de escribir.
- **Conflictos por fecha, sin fusionar el JSON**: un merge a tres bandas sobre el árbol de Tiptap
  puede dejar un fichero que ya no parsea, y ahí sí se pierde la nota entera. Gana el
  `modificado` más nuevo y la otra versión queda como `<id>.conflicto-<fecha>.json`, que el
  indexador ya ignora (4.23) y la UI anuncia. Nunca se pierde nada.
- **Sincronización automática**: `cargarSesion` + pull al arrancar (después de pintar: si GitHub
  tarda o no hay red, la app ya es usable) y push tras el autoguardado con debounce, sin `await`
  — guardar en local no puede depender de que haya red. Punto azul en ⚙ mientras trabaja.
- **GOTCHA — git no versiona directorios**: al borrarse la última nota, `notas/` desaparece en el
  otro equipo y el siguiente guardado fallaba. `Almacen::escribir` recrea la carpeta. Lo destapó
  el test del borrado, no el uso.
- **GOTCHA — `camelCase` en la frontera**: serde serializa `codigo_usuario`/`ultimo_commit` tal
  cual y TypeScript espera camelCase. `#[serde(rename_all = "camelCase")]` en los structs que
  cruzan (`CodigoDispositivo`, `EstadoSincro`); los demás son de una sola palabra y no sufren.
- **GOTCHA — `all: unset` quita `position`**: el punto de actividad sobre ⚙ se anclaba a un
  ancestro cualquiera hasta poner `position: relative` en `.btn-tema`.
- 10 tests de Rust (`sincro.rs`, contra un repositorio *bare* en disco: sin red ni credenciales)
  + 3 de `github.rs` + 7 del diálogo en Angular.
- **Aviso consciente**: la app es offline-first y esto sube las notas a un tercero. Repo privado,
  pero GitHub puede leerlo. La misma URL sirve para un **Gitea auto-hospedado**; para privacidad
  real haría falta cifrar el contenido (`git-crypt`/`age`), no solo el transporte.

### 4.23 Workspace en ficheros (sincronizable entre equipos)
- **La nota pasa a ser un fichero**: `Workspace/notas/<id>.json`, JSON de Tiptap **formateado
  con indentación**. `workspace.db` baja a **índice derivado** (listado, etiquetas, FTS5) que
  se reconstruye al arrancar leyendo `notas/`. Nuevo módulo `src-tauri/src/almacen.rs`.
- **Por qué:** para tener las notas en varios equipos. Con un fichero por nota, git / Syncthing
  / un pendrive valen tal cual. Meter `workspace.db` en la sincronización es justo lo contrario:
  SQLite escribe en varios pasos no atómicos (copiarlo a media escritura lo parte) y el
  conflicto es del **cuaderno entero** — eliges un lado y pierdes todas las notas del otro.
  El `.gitignore` que se escribe en el workspace lo excluye.
- **El borrado viaja solo**: que el fichero desaparezca *es* la lápida. Con sync a nivel de
  filas haría falta una tabla de borrados o la nota reaparecería desde el otro equipo.
- **JSON y no Markdown** (decidido a propósito): Markdown daría diffs perfectos e interop con
  Obsidian (incluido leer las notas desde el móvil), pero **color de texto, resaltado,
  alineación y las listas planas no tienen sintaxis Markdown** y se perderían. Medido con git
  real: cambiar una palabra en una nota de 50 líneas da un diff de **+2 −2**. `to_string_pretty`
  + `serde_json` (que ordena las claves de los objetos) hace la salida determinista; las
  etiquetas se ordenan por lo mismo, para que reordenarlas no ensucie el diff.
- **Escritura atómica** (temporal + `rename`): un corte de luz o un sincronizador copiando en
  ese instante ven la versión vieja o la nueva, nunca media nota.
- **GOTCHA — orden en el arranque**: `migrar_desde_db` (vuelca a fichero lo que solo estaba en
  SQLite, para workspaces anteriores) va **antes** de `reconstruir`. Al revés, la reconstrucción
  vacía las tablas y se lleva por delante las notas antes de haberlas salvado. Es idempotente:
  solo migra si `notas/` está vacío.
- **GOTCHA — copias en conflicto**: `nota.sync-conflict-….json` lleva **el mismo id dentro** que
  el original; si se leyera, una versión pisaría a la otra según el orden del directorio. Se
  ignoran al indexar (se quedan en disco para que el usuario decida). Igual con un JSON roto:
  se registra y se salta, un fichero malo no puede dejarte sin biblioteca.
- `obtener_documento` lee del **fichero** (fuente de verdad); `listar`/`buscar` van al índice.
- Nuevo comando **`recargar_workspace`** → relee `notas/` y rehace el índice sin reiniciar,
  para después de un `git pull` con la app abierta. Expuesto en `DocumentosService.recargar()`.
- La tabla `asset` también se rehace recorriendo `assets/` (el nombre ya es `<sha256>.<ext>`),
  así las imágenes que llegan de otro equipo quedan registradas solas.
- `id_valido()` antes de usar el id como nombre de fichero: el id llega desde el webview y un
  `../../algo` escribiría fuera de `notas/`.
- 12 tests de Rust (`cargo test`): round-trip, indentación, salida determinista, borrado,
  reconstrucción, búsqueda tras reconstruir, cambios llegados de fuera, copias en conflicto,
  fichero roto, migración, path traversal y `.gitignore`.

### 4.22 Zoom en el visor de imagen (lightbox)
- Rueda del ratón para acercar/alejar (100 %–800 %), arrastrar para moverse, doble clic para
  alternar entre la imagen entera y ×2,5. Indicador del aumento arriba a la izquierda.
- **El zoom va al puntero**, no al centro: se resuelve `d' = u − k·(u − d)` (con `u` = cursor
  respecto al centro y `k` = razón de aumento). Si no, al ampliar te vas al centro y pierdes
  justo lo que estabas mirando. Comprobado en WebKitGTK: el punto bajo el cursor se queda
  clavado (0 px de desvío).
- El desplazamiento se recorta (`limitar`) para que la imagen no se pueda sacar de la vista.
  El aumento se aplica con `transform`, que NO cambia el hueco que ocupa la imagen: por eso
  `offsetWidth` sigue dando su tamaño real y sirve para calcular el tope.
- **GOTCHA:** tras arrastrar hay que descartar el `click` que el navegador dispara al soltar
  (si el puntero acaba fuera de la imagen, ese clic cae en el fondo y cerraría el visor). La
  marca se limpia al empezar cada gesto y al hacer clic en la imagen; si solo se limpiara en
  el fondo, se quedaba puesta y se comía el siguiente clic de cierre.

### 4.21 Entrada "Imagen" en el menú "/"
- Nueva opción **Imagen** en el menú `/` (y en el botón del toolbar, que ya estaba): borra el
  `/imagen` escrito y abre el selector de ficheros del sistema → pantalla de edición.
- Elegir el fichero es cosa del COMPONENTE (diálogo nativo de Tauri + `MatDialog`), no de una
  extensión de Tiptap, así que la entrada avisa con un **CustomEvent** (`EVENTO_IMAGEN`)
  sobre el DOM del editor y `editor.ts` lo escucha. Sin acoplar la extensión al componente.
- `SlashItem` gana la marca **`insercion`** (divisor e imagen): el menú del bloque ⠿ reutiliza
  la lista para "convertir en…" y ahí esas dos no pintan nada. Antes se filtraba por título.

### 4.20 Editor de imagen al insertar (estilo WhatsApp)
- **Toda imagen que entra pasa antes por una pantalla de edición** a pantalla completa
  (`editor/anotar-imagen.ts`, un `MatDialog`): las 4 vías (pegar bytes, pegar ruta, botón
  "Insertar", doble vía del portapapeles) desembocan en `editarImagen()`.
- Formas: **rectángulo redondeado, círculo, línea y flecha**, siempre **solo trazo, sin
  relleno** (`fill: none` en el SVG y nunca se llama a `fill()` en el canvas). Se crean
  arrastrando y se mueven arrastrándolas por su trazo. Paleta de 6 colores, deshacer
  (Ctrl+Z), borrar la seleccionada (Supr). El marco de la seleccionada es **morado**, un
  color que no está en la paleta: así nunca se confunde con la forma que rodea.
- **Al soltar el ratón, la forma recién dibujada queda seleccionada** (como en cualquier
  editor): se puede borrar con Supr, recolorear o mover en el acto. Consecuencia a tener
  presente: elegir un color entonces repinta ESA forma en vez de preparar el de la
  siguiente; para empezar de cero, un clic en zona libre deselecciona.
- **Texto**: se hace clic y se escribe en un `<input>` superpuesto (cajetín crema, estilo
  WhatsApp) que se **ciñe a lo escrito** midiéndolo con la misma función que el render
  final. Enter lo coloca, y desde ese momento se arrastra como cualquier otra forma;
  **doble clic sobre él lo vuelve a abrir** para retocarlo. El texto **sí es macizo** para
  el ratón (se agarra por dentro, no por el borde). Cuerpo de letra en cuatro tamaños y
  opción **Fondo (sin / con)**: la pastilla es **siempre blanca** (`COLOR_FONDO`) y la letra
  conserva el color elegido. Antes la pastilla tomaba el color de la paleta y la letra el
  contrario, y se volvía confuso qué estaban cambiando los círculos de color: la paleta es
  la del TEXTO y solo la del texto.
  Vista previa y exportación comparten familia y peso de fuente a propósito —el
  CSS de `.lienzo text` y `fuenteDe()` deben ir de la mano— o el texto bailaría.
- Los controles de texto (tamaño y fondo) salen con la herramienta puesta, mientras se
  escribe **y con un texto seleccionado**, para poder retocarlo después. Al seleccionar algo
  los controles se ponen en lo que ese algo tiene (`sincronizarControles`): la paleta marca
  su color y, si es texto, también su tamaño y su fondo.
- **Al abrir el cajetín la herramienta se desarma** (`herramienta = null`): si siguiera
  armada, el clic con el que se cierra el cuadro abriría otro detrás. Eso añade un estado
  sin herramienta —solo seleccionar y mover— que se nota en que ningún botón queda
  resaltado, el cursor es una flecha y no una cruz, y la pista lo dice.
- Color, tamaño y fondo se pueden cambiar **mientras se escribe**, y el cajetín lo refleja
  al vuelo. Para eso, esos botones llevan `(mousedown)="$event.preventDefault()"`: sin él
  le robaban el foco al `<input>`, el `blur` daba el texto por escrito y el cambio llegaba
  cuando ya no había nada abierto que cambiar. El ancho del cajetín se mide en `cajetin()`
  a partir del texto en curso (y no al teclear), para que agrandar la letra lo reajuste.
- **GOTCHA (foco del cajetín):** pedir el foco con `setTimeout(0)` NO funciona. La app usa
  `provideZoneChangeDetection({ eventCoalescing: true })`, que aplaza la detección de
  cambios al siguiente frame, así que el temporizador se ejecutaba **antes de que existiera
  el `<input>`**: la consulta devolvía `undefined`, el foco no se ponía y había que volver a
  pulsar dentro del cajetín para escribir. Se arregla con **`afterNextRender`**. El síntoma
  engaña —parece un robo de foco— y solo se localizó midiendo `document.activeElement` en
  WebKitGTK y viendo que un `focus()` a mano sí funcionaba.
- **Recortar y girar** (un solo botón, como en WhatsApp): con esa herramienta activa se
  arrastra la zona a conservar (lo de fuera se oscurece) y la barra inferior cambia la
  paleta por *Girar a la izquierda / Girar a la derecha / Restablecer*.
- Ambas operaciones **rehacen la imagen** (a un blob nuevo) y **transforman las anotaciones
  con ella**. Se eligió eso, y no guardar recorte y giro como estados aparte, porque si no
  hay que decidir en qué marco de referencia vive cada uno en cuanto se combinan
  ("girar → recortar → girar"), que es donde salen los bugs raros. Así solo existe un marco:
  el actual.
- **Giros solo de 90°**, nunca libres: son exactos (permutan coordenadas, sin interpolar),
  no pierden nitidez por más veces que se giren y el lienzo solo intercambia lados. Con un
  ángulo cualquiera habría que remuestrear, agrandar el lienzo para que quepa la diagonal e
  invertir una transformación afín completa para pasar de ratón a píxel.
- **Restablecer** vuelve a la imagen de partida **sin perder las anotaciones**: se guarda el
  `Encaje` acumulado (`k` cuartos de vuelta + desplazamiento) y se aplica su inverso, así
  que hasta lo dibujado después de recortar acaba donde le toca sobre la imagen entera.
- **El texto es el caso especial al girar**: se transforma su CENTRO y se rehace la caja a
  su alrededor, porque siempre se pinta derecho (girarlo con la imagen lo dejaría tumbado) y
  al girar se intercambian su ancho y su alto.
- **Historial de deshacer** (`Estado[]`: formas + imagen + tamaño). Antes era "quitar la
  última forma", que ni deshacía un movimiento ni podía deshacer un recorte. Se apunta el
  estado ANTES de cada cambio; un clic que no llegó a mover nada retira su propio apunte.
- La geometría vive aparte, en **`editor/formas.ts`** (crear/mover/medir/pintar + acierto
  del ratón), sin nada de UI: así se prueba sola (`formas.spec.ts`, 28 tests; varios pintan
  en un canvas de verdad y comprueban lo que se ve: que **el centro de la forma queda
  transparente**, que **el texto sin pastilla no lleva ningún contorno**, y que con pastilla
  el fondo va del color elegido y la letra del contrario).
- **Un único sistema de coordenadas**: todo se guarda en píxeles de la imagen ORIGINAL. La
  vista previa es un `<svg viewBox="0 0 ancho alto">` superpuesto y la exportación un canvas
  de ese mismo tamaño → lo exportado es exactamente lo que se vio, sin factores de escala.
- **Aceptar sin dibujar nada no recomprime**: se guarda el original tal cual (`{editada:false}`).
  Si se dibujó, se compone en un canvas y se guarda como PNG (o JPEG si el original lo era,
  para no inflar una foto). Cancelar no inserta nada.
- **Pantalla de carga al guardar** (mínimo 400 ms; si tarda más, sigue hasta terminar). Tapa
  el diálogo entero mientras se compone la imagen y se escribe en disco: antes la app se
  quedaba tiesa un rato y luego la imagen aparecía de golpe. Tres detalles necesarios:
  1. El guardado se hace **dentro del diálogo**, no al cerrarlo: `AnotarDatos.guardar` es un
     callback que pone `editor.ts`. Si no, la pantalla de carga solo cubriría la mitad del
     tiempo (la otra mitad es el `invoke` a Rust, ya con el diálogo cerrado).
  2. Antes de exportar se **cede el turno dos fotogramas** (`requestAnimationFrame`
     anidados). `toDataURL()` de la imagen entera bloquea el hilo, así que sin ceder el
     turno la pantalla de carga no se llegaría a pintar y no se vería nada.
  3. El mínimo de 400 ms evita el parpadeo cuando el guardado es rápido, que se lee como un
     fallo. El anillo giratorio es CSS propio y no `mat-spinner`: el de Material hace crecer
     y encoger su arco, y en el instante malo no se ve más que un punto.
- **SVG y GIF se insertan sin pasar por el editor** (`SIN_EDITOR`): editar = rasterizar, y
  eso convertiría el SVG en mapa de bits y dejaría el GIF en su primer fotograma.
- Backend: comando **`leer_imagen`** (bytes en base64 + extensión). Hace falta porque la
  imagen acaba en un `<canvas>` que se exporta: si se cargara por `convertFileSrc`
  (protocolo `asset://`, otro origen) el lienzo quedaría *tainted* y `toDataURL()` fallaría.
  Con los bytes se crea un `blob:` del mismo origen y el problema desaparece.
- `autoFocus: 'dialog'` (no `false`): si el foco se quedara en el editor de detrás, escribir
  con la pantalla abierta editaría el documento. Verificado en WebKitGTK.

### 4.7 Barra de herramientas superior (estilo Word)
- Barra **sticky** arriba del panel, **por encima del título**, siempre visible al hacer scroll.
- Vive en `app.html` y controla el editor por referencia de plantilla `#ed`.
- Iconos Material: undo/redo, H1-H3, negrita/cursiva/subrayado/tachado/código,
  listas, cita/bloque-código/divisor, "Insertar" imagen y "Guardar".
- **Una sola fila con scroll horizontal (4.16):** antes usaba `flex-wrap: wrap` (los botones
  saltaban de línea al comprimir); ahora `flex-wrap: nowrap` + `overflow-x: auto` (como Tiptap):
  si no caben, se **desplaza en horizontal**. Directiva `shared/drag-scroll.ts` (`appDragScroll`):
  arrastrar con ratón + rueda vertical→horizontal, sin romper los clics (umbral 5px + suprime el
  clic tras arrastrar). Los ítems llevan `flex: 0 0 auto` (no se encogen); barra de scroll oculta.
  El **popover del enlace** pasó a `position: fixed` posicionado por JS (`enlacePos`) para no ser
  recortado por el `overflow` del toolbar.

### 4.8 Icono y portada de documento (estilo Notion)
- El backend ya soportaba `icono` y `cover` (modelo + tabla + guardar/cargar); solo faltaba la UI.
- **Icono (emoji):** componente propio `documento/emoji-picker.ts` — selector **offline sin
  dependencias**, con 8 categorías en pestañas (~300 emojis curados), "Aleatorio" y "Quitar".
  Se muestra como emoji grande sobre el título; clic para abrir/cambiar. Cierra con clic fuera o Esc.
  El icono también aparece en la barra lateral (ya estaba `d.icono || '📄'`).
- **Buscador por nombre (4.14):** cada emoji lleva palabras clave en español (`{e, k}`); un campo
  de búsqueda (autofocus) filtra en TODAS las categorías, **sin acentos ni mayúsculas** (normaliza con
  NFD). Al escribir se ocultan las pestañas y se muestran los resultados; Esc limpia la búsqueda (y si
  ya está vacía, cierra). Sin dependencias.
- **Portada:** banner a lo ancho del panel arriba del documento. "Agregar/Cambiar portada" abre el
  diálogo nativo y reutiliza `importar_asset` (copia a `assets/`, dedup por hash); se muestra con
  `convertFileSrc`. El icono se **solapa** sobre el borde inferior de la portada (clase `.con-cover`).
- Los cambios de icono/portada se guardan con el botón **Guardar** (igual que título/contenido).

### 4.9 Búsqueda de texto completo (FTS5)
- **Tabla virtual FTS5** `document_fts(doc_id UNINDEXED, titulo, texto)` con tokenizer
  `unicode61 remove_diacritics 2` → **búsqueda sin acentos** (canción ≈ cancion).
- Rust extrae el **texto plano** del JSON de bloques (`extraer_texto`, recorre los nodos `text`) y
  mantiene el índice sincronizado en `guardar` (delete+insert) y `eliminar`. `abrir` **reindexa**
  los documentos previos si el índice está vacío (migración de BDs anteriores).
- Comando `buscar_documentos(consulta)`: cada palabra se vuelve término con prefijo (`"palabra"*`)
  para filtrar según se escribe; ordena por `rank`, límite 50. Devuelve `ResultadoBusqueda`
  (id, titulo, icono, modificado, **fragmento** con `snippet()`, términos entre U+0002/U+0003).
- UI: buscador en la sidebar (debounce ~200 ms). Con texto muestra resultados con **resaltado**
  (`<mark>`, sin `innerHTML`: se parte el fragmento por los marcadores); sin texto, la lista normal.
- **Resaltado también en el título**: el título usa `highlight(document_fts, 1, …)` (devuelve el
  título completo con marcadores, no truncado como `snippet`), y el frontend lo pinta con el mismo
  `partesFragmento`. Así el resaltado respeta la tokenización sin acentos del backend (no se imita
  en el cliente). Estilo de `<mark>` compartido en `.sidebar mark`.
- **FTS5 viene habilitado** en `rusqlite` con la feature `bundled` (no hace falta feature extra).

### 4.19 Títulos: botón desplegable (H ▾) con 4 niveles
- Los tres botones sueltos H1/H2/H3 se sustituyen por un único botón **H ▾** (letra H + `expand_more`)
  que abre un **menú** con H1–H4 (badge `[Hn]` + "Título n"; el nivel activo se resalta).
- Editor: `heading: { levels: [1,2,3,4] }` en StarterKit; `toggleHeading(1|2|3|4)`. Estilo `h4` añadido.
- El desplegable usa **CDK Overlay** (`OverlayModule`, `cdkConnectedOverlay` + `cdkOverlayOrigin`):
  el CDK lo posiciona dentro del viewport (varias `ConnectedPosition` + `push`), así aparece bien
  aunque la ventana sea pequeña — sin cálculo de posición a mano. Igual se migró el **popover de
  enlace**. Como el overlay se renderiza fuera del componente, sus estilos (`.menu-titulos`,
  `.enlace-pop`, `.mini-btn`…) están en **styles.scss (global)**; el CSS del overlay se añadió en
  angular.json (`@angular/cdk/overlay-prebuilt.css`). Backdrop transparente del CDK cierra al clic fuera.

### 4.21 Alineación de texto (botón desplegable)
- Nueva extensión `@tiptap/extension-text-align` (`TextAlign.configure({ types: ['heading','paragraph'] })`).
  Método editor `setAlineacion('left'|'center'|'right'|'justify')`. `isActive` del editor ampliado para
  aceptar también la forma `isActive({ textAlign })` (solo atributos).
- Botón desplegable (icono alinear + `expand_more`) con menú CDK Overlay (`menuAlinear`, `posicionesMenu`):
  Izquierda / Centrar / Derecha / Justificar (icono + etiqueta, activa resaltada). El botón se marca si la
  alineación no es la de por defecto (center/right/justify).

### 4.22 Color de texto y resaltado
- Extensiones `@tiptap/extension-text-style` (aporta `TextStyle` + `Color` en Tiptap 3) y
  `@tiptap/extension-highlight` (`multicolor: true`). Métodos editor: `setColorTexto/quitarColorTexto/
  colorTextoActual` y `setResaltado/quitarResaltado/resaltadoActual`.
- Dos botones desplegables (CDK Overlay): **color de texto** (`format_color_text`) y **resaltado**
  (`format_color_fill`), cada uno con una **paleta de swatches** (12 colores) + "Quitar". El swatch activo
  se marca; el botón se resalta si hay color/resaltado aplicado. Estilos `.menu-colores`/`.swatch` en global.
- El botón de color de texto muestra una **"A" con barra del color actual** debajo (`.color-a`/`.color-bar`,
  `background = colorTextoActual() || currentColor`).

### 4.20 Listas: botón desplegable (CDK Overlay)
- Los tres botones de lista (viñetas/numerada/tareas) → un botón con icono de lista + `expand_more`
  que abre un menú **CDK Overlay** (mismo patrón que títulos: `menuListas`, `posicionesMenu`, backdrop)
  con las 3 opciones (icono + etiqueta, la activa resaltada). El botón se marca si hay cualquier lista.
- Estilo `.menu-ico` (icono en el ítem del menú) añadido en styles.scss (global).

### 4.18 Sidebar colapsable (botón hamburguesa)
- Botón **hamburguesa** arriba de la sidebar; `toggleSidebar()` alterna `sidebarColapsada` (signal).
- Colapsada: la columna del grid pasa de `280px` a **`56px`** (con transición) y se muestra una **vista
  de solo iconos**: se oculta título/buscador/etiquetas/lista Material y se pinta `.lista-iconos` con un
  botón por documento mostrando solo su emoji (tooltip = título, clic abre, resaltado el activo). El
  botón "Nuevo" pasa a icono `+`. Todo en `app.html`/`app.scss` (clase `.colapsada` en `.app`).

### 4.17 Botón "Copiar" en los bloques de código
- Extensión `editor/code-block-copia.ts`: extiende `@tiptap/extension-code-block` con un **NodeView**
  que envuelve `<pre><code>` en un `div.code-block` y añade un botón **Copiar** (esquina sup. dcha.,
  visible al pasar el ratón). Al pulsar copia el texto del bloque (`navigator.clipboard` con fallback
  a textarea + `execCommand`) y muestra "¡Copiado!" 1,5 s.
- El botón va fuera del `contentDOM` (`contentEditable=false`, `mousedown` con `preventDefault` para no
  robar la selección) e `ignoreMutation` evita que sus cambios confundan a ProseMirror.
- En `editor.ts` se desactiva `codeBlock` de StarterKit (`codeBlock: false`) y se añade `CodeBlockCopia`
  (mismo nombre de nodo → `toggleCodeBlock`, input rule ``` y atajos siguen funcionando).

### 4.15 Etiquetas (tags)
- Usa las tablas `tag` / `document_tag` (N–N) que ya existían. Enfoque: **chips en el documento +
  filtro en la sidebar**, etiquetas **case-insensitive** (se normalizan: trim + espacios + minúsculas).
- **Rust:** `Documento.tags: Vec<String>`; `guardar` **sincroniza** las etiquetas (borra relaciones,
  crea las que falten con `ON CONFLICT(nombre) DO NOTHING`, enlaza, y **poda** las huérfanas) → encaja
  en el autoguardado. `obtener`/`listar` devuelven las tags (join / `group_concat`). Nuevo comando
  `listar_etiquetas` → `TagInfo { nombre, usos }` (para autocompletado y filtro).
- **Front:** en el documento, fila de chips (con ✕) + input con `<datalist>` de autocompletado; Enter
  añade y dispara autoguardado. En la sidebar, chips de todas las etiquetas para **filtrar** la lista
  (`documentosVisibles` = filtra por `filtroTag`). Color del chip derivado del nombre (hash → tono HSL).

### 4.12 Thumbnails de imágenes (preview en editor + original al clic)
- **Rust** (crate `image`, features recortadas a png/jpeg/gif/bmp/webp para NO arrastrar AVIF/ravif):
  al guardar una imagen (`escribir_asset`), `generar_preview` crea una miniatura ligera (máx **1024px**
  de lado, JPEG si es opaca / PNG si tiene alfa) en `assets/<hash>.prev.{jpg,png}`. Se omite si la
  imagen ya es pequeña, si es SVG, o si no se puede decodificar → `preview = None`.
- `AssetGuardado` devuelve el nombre del `preview`.
- **Editor:** el nodo imagen guarda en `src` el nombre del **original** (portable) y en `preview` la
  miniatura; en el DOM se muestra el **preview** (carga rápida en docs con imágenes grandes). **Doble
  clic** en la imagen abre el **original a tamaño completo** en un lightbox (Esc o clic fuera cierra).
- Compatible con imágenes antiguas (sin `preview` → se muestra el original).

### 4.10 Autoguardado (debounce)
- Se quitó el botón **Guardar**; ahora se guarda solo **~800 ms después** de dejar de editar
  (título, contenido, icono o portada). En su lugar, un **indicador de estado** en el toolbar:
  *Sin guardar* → *Guardando…* (icono girando) → *Guardado*.
- El autoguardado se dispara **solo desde las ediciones del usuario** (no observando la señal
  `actual`), así que no hay bucle de eco con la carga/guardado.
- Al volver del guardado se fusionan **solo `id`/fechas** (no el contenido) para **no pisar** lo
  que se haya escrito durante el guardado. Nuevo doc: el primer guardado hace INSERT y devuelve el
  `id`; los siguientes ya son UPDATE.
- **Flush** de lo pendiente al **cambiar/crear** documento (no se pierden cambios). Un documento
  nuevo **en blanco no se guarda** hasta que se edita algo. **Ctrl/Cmd+S** fuerza el guardado.

### 4.11 Enlaces (Link) en el toolbar
- Link ya viene en **StarterKit**; se configuró `link: { openOnClick: false, autolink: true }`.
  `openOnClick:false` porque en el webview de Tauri un clic navegaría y **reemplazaría la app**;
  `autolink` enlaza URLs al escribirlas.
- Métodos en el editor: `enlaceActual()` (href bajo el cursor), `aplicarEnlace(url)` (a la selección,
  o inserta la URL como texto enlazado si no hay selección; URL vacía = quitar), `quitarEnlace()`.
  `normalizarUrl` antepone `https://` si no hay esquema (respeta `mailto:`/`tel:`/`/`).
- UI: botón 🔗 en el toolbar que abre un **popover** con input (autofocus) + *Aplicar* y, si el cursor
  está sobre un enlace, *Quitar*. Enter aplica, Esc cierra. Estilo del `<a>` en `styles.scss`.
- **Ctrl/Cmd+clic abre el enlace en el navegador del sistema** — vía `tauri-plugin-shell`.
  Backend: `tauri-plugin-shell` en Cargo.toml, `.plugin(tauri_plugin_shell::init())` en lib.rs,
  permiso `shell:allow-open` en `capabilities/default.json`. Frontend: `open as abrirEnSistema`
  desde `@tauri-apps/plugin-shell` + `editorProps.handleClick` (si Ctrl/Cmd, busca el `<a>` con
  `closest('a')`, abre su href y devuelve true). El `<a>` lleva `title="Ctrl+clic para abrir"`.

---

## 5. Decisiones clave y gotchas (¡importante!)

1. **BlockNote descartado**: su UI es React-only; en Angular solo hay un wrapper de
   comunidad. Elegido **Tiptap** (framework-agnóstico, nativo en Angular).
2. **El template "Notion-like" oficial de Tiptap es React + de pago** (Tiptap Cloud).
   Replicamos la experiencia nosotros con extensiones open-source.
3. **SQLite con comandos Rust propios** (`rusqlite`), NO `tauri-plugin-sql`: así Rust
   es el dueño real de la BD/búsqueda/indexación.
4. **WebKitGTK rompe el DnD nativo de HTML5** → drag handle y "arrastrar imágenes del
   escritorio" NO funcionan por esa vía. Reordenado = eventos de puntero; imágenes =
   pegar o botón de fichero.
5. **Fuentes self-hosteadas → offline 100%** ✅ — Material Icons
   (`public/fonts/material-icons.woff2`) y **Roboto ESTÁTICO por peso**
   (`public/fonts/roboto-300/400/500.woff2`, de `@fontsource/roboto`) con `@font-face` en
   `styles.scss`. Se quitaron **ambos** `<link>` de Google Fonts de `index.html`. Sin referencias
   a `googleapis`/`gstatic`.
   **GOTCHA:** primero se usó la fuente **variable** de Google (un archivo, `font-weight:100 900`)
   y en el webview de Tauri (**WebKitGTK**) el texto **cambiaba de grosor / caía al fallback del
   sistema al escribir**. Solución: **Roboto estático por peso** (`@fontsource`). Google ya solo
   sirve Roboto como variable (incluso la API `css` clásica da el mismo archivo para 300/400/500),
   por eso se recurrió a `@fontsource` para obtener estáticos (pesos 300/400/500/700).
   Además: `-webkit-font-smoothing: antialiased` en el `body` porque WebKit pinta el texto más
   grueso por defecto. **OJO dev:** al añadir fuentes a `public/` con `ng serve` corriendo hay que
   **reiniciar** para que las sirva (si no, 404 → fallback grueso del sistema).
7. **Layout responsive (contenido que no se sale):** dos claves — (a) los items de grid/flex
   necesitan **`min-width: 0`** para poder encogerse por debajo de su contenido (si no, un `<pre>`
   o una URL larga expande el `.pane` y aparece scroll lateral); (b) **`box-sizing: border-box`
   global** para que `width:100%` + padding no se desborde por el ancho del padding. Además
   `.ProseMirror { overflow-wrap: break-word }` y `<pre> { overflow-x: auto }` (scroll propio del código).

6. **Ruta de assets RELATIVA** ✅ — el documento guarda solo el **nombre** del fichero
   (p.ej. `a1b2….png`), no la ruta absoluta → el `Workspace` es **portable** entre máquinas.
   Al mostrar, se resuelve contra `Workspace/assets/` de la máquina actual (`core/asset-path.ts`).
   La tabla `asset` ya guardaba el nombre relativo; solo faltaba el JSON del documento. Compatible
   con documentos antiguos (rutas absolutas): se muestran igual y se **migran a relativo al abrirlos**.

---

## 6. Próximos cambios a realizar

### Prioritarios / pedidos
- [x] **Búsqueda (FTS5)** ✅ — tabla virtual FTS5, `extraer_texto` del JSON, comando
      `buscar_documentos`, buscador con resaltado en la sidebar. Ver 4.9.
- [x] **Iconos y portada de documento** ✅ — selector de emoji propio (offline) para el icono
      y banner de portada con `importar_asset`. Ver 4.8. *(Mejora futura: búsqueda por nombre en el
      selector de emojis y autoguardado.)*

### Editor
- [x] **Reordenar ítems dentro de listas** ✅ — `blockAt` apunta al ítem de lista más
      profundo + validación por esquema (`canReplaceWith`). Ver 4.5/4.13.
- [ ] Cerrar el slash menu al hacer click **fuera** del editor (ahora: Esc / selección).
- [ ] Pulir posicionamiento del handle ⠿ en ventanas estrechas.
- [x] **Enlaces (Link)** ✅ — botón 🔗 + popover con input en el toolbar; **Ctrl/Cmd+clic** abre
      el enlace en el navegador (`tauri-plugin-shell`). Ver 4.11.

### Assets / robustez
- [x] **Thumbnails** de imágenes generados por Rust ✅ — preview ligero en el editor + original a
      tamaño completo con doble clic (lightbox). Ver 4.12.
- [x] **Ruta de assets relativa** ✅ — el documento guarda el nombre del fichero; se resuelve
      contra `Workspace/assets/` al mostrar (`core/asset-path.ts`). Ver gotcha #6.
- [x] **Self-hostear fuentes (offline 100%)** ✅ — Material Icons + Roboto (variable) en
      `public/fonts/`, `@font-face` en `styles.scss`, sin ningún CDN de Google Fonts.

### Calidad / mantenimiento
- [x] **Actualizar `app.spec.ts`** ✅ — mocks de servicios (sin Tauri) + `provideNoopAnimations`;
      4 tests en verde (`ng test --no-watch --browsers=ChromeHeadless`).
- [x] **Autoguardado** (debounce) en vez del botón Guardar manual ✅ — ver 4.10.
- [x] **Etiquetas** (`tag` / `document_tag`) ✅ — chips en el documento + filtro en la sidebar,
      case-insensitive, sincronizadas en el guardado. Ver 4.15.
- [ ] IA/OCR local; exportar (PDF/Markdown) (visión a largo plazo).

### Sincronización entre equipos (ver 4.23)
- [x] **Workspace en ficheros** ✅ — una nota por `notas/<id>.json`, `workspace.db` como índice
      reconstruible. Ya se puede sincronizar con git / Syncthing / pendrive. Ver 4.23.
- [x] **Cuenta de GitHub y git automático** ✅ — device flow, crear/conectar repositorio desde
      ⚙ Ajustes, `pull` al arrancar y `push` tras el autoguardado. Ver 4.24.
- [x] **Bóvedas (varios workspaces)** ✅ — selector en la barra lateral, crear y cambiar; cada
      una con su repositorio. Ver 4.25.
- [x] **Notas bloqueadas en bóvedas compartidas** ✅ — cuaderno de equipo con hojas protegidas y
      restauración automática en la copia del dueño. Ver 4.28.
- [x] **Bóvedas de solo lectura** ✅ — se respeta el permiso real de GitHub. Ver 4.26.
- [ ] **Conectar una bóveda compartida en un paso**: hoy son dos (crear bóveda vacía → Ajustes →
      Conectar con uno existente). Funciona, pero se nota la costura.
- [ ] **Renombrar/quitar bóvedas desde la UI**: los comandos existen (`renombrar_boveda`,
      `olvidar_boveda`) pero no hay dónde pulsarlos.
- [ ] **Mover una nota entre bóvedas**: habría que llevarse también sus imágenes, porque los
      assets viven dentro de cada bóveda.
- [ ] **Elegir versión en los conflictos**: hoy la UI dice cuántas notas quedaron en conflicto y
      la versión perdedora está en disco, pero no hay pantalla para compararlas y quedarse con
      una. Es el siguiente paso natural de 4.24.
- [x] **Client ID de la OAuth App puesto** ✅ — `Ov23liH7C3x7BFeEoL5G` en `github.rs`.
      Comprobado contra GitHub que el device flow está activo (devuelve `user_code`, no
      `device_flow_disabled`). Un test vigila que no se quede sin poner en un refactor.
- [ ] `git-lfs` para `assets/` si el repo crece: el editor de imagen funde las anotaciones en
      un PNG nuevo al guardar, y git no olvida los blobs (cada retoque queda para siempre).
- [ ] Botón/atajo para `recargar_workspace` (o al recuperar el foco de la ventana).

### Editor de imagen (ver 4.20)
- [x] **Formas sobre la imagen al insertarla** ✅ — rectángulo, círculo, línea y flecha, solo
      borde; se colocan arrastrando y se mueven. Ver 4.20.
- [x] **Texto, recorte y giro de 90°** ✅ — ver 4.20.
- [ ] Redimensionar una forma ya colocada (ahora el tamaño se fija al dibujarla).
- [ ] Más herramientas: difuminado (pixelar datos sensibles), lápiz libre.
- [ ] Giro libre (cualquier ángulo): **descartado a propósito**, ver 4.20.
- [ ] Reeditar las anotaciones de una imagen ya insertada. Hoy se **funden** en el fichero
      (como WhatsApp): el resultado es una imagen normal, portable y copiable fuera, pero las
      formas ya no se pueden mover. Guardarlas aparte en el nodo permitiría reeditarlas, a
      cambio de que al copiar la imagen fuera de la app no viajaran con ella.
