use std::fs;
use std::path::Path;

use base64::{engine::general_purpose, Engine};
use image::GenericImageView;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::almacen;
use crate::db::Db;
use crate::bovedas::{Boveda, Bovedas};
use crate::github::{self, CodigoDispositivo, RepoGitHub, Sesion, UsuarioGitHub};
use crate::secretos::{EstadoSecretos, Secretos};
use crate::models::{
    AssetGuardado, Documento, DocumentoResumen, ImagenLeida, ResultadoBusqueda, TagInfo,
};
use crate::sincro::{self, EstadoSincro, ResultadoSincro};

/// Lado máximo (px) de la miniatura de previsualización.
const PREVIEW_MAX: u32 = 1024;

/// Genera una miniatura ligera (máx. PREVIEW_MAX px de lado) para imágenes
/// rasterizadas grandes. Devuelve el nombre del fichero, o None si no aplica
/// (imagen ya pequeña, formato no soportado, o error al decodificar).
fn generar_preview(dir: &Path, hash: &str, bytes: &[u8], ext: &str) -> Option<String> {
    if !matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return None;
    }
    let img = image::load_from_memory(bytes).ok()?;
    let (ancho, alto) = img.dimensions();
    if ancho <= PREVIEW_MAX && alto <= PREVIEW_MAX {
        return None; // ya es suficientemente pequeña: se usa el original
    }

    let miniatura = img.thumbnail(PREVIEW_MAX, PREVIEW_MAX); // conserva el aspecto
    // JPEG para fotos (más ligero); PNG si tiene transparencia.
    let (nombre, formato) = if img.color().has_alpha() {
        (format!("{hash}.prev.png"), image::ImageFormat::Png)
    } else {
        (format!("{hash}.prev.jpg"), image::ImageFormat::Jpeg)
    };

    let ruta = dir.join(&nombre);
    if !ruta.exists() {
        miniatura.save_with_format(&ruta, formato).ok()?;
    }
    Some(nombre)
}

/// Corta las escrituras que no están permitidas en la bóveda activa.
///
/// Dos niveles:
/// - **la bóveda entera** es de solo lectura (GitHub no da permiso de empuje);
/// - **la nota está bloqueada** y no eres el dueño de la bóveda.
///
/// Va **en Rust y no solo en la interfaz** a propósito: la plantilla oculta los
/// controles, pero el webview es la parte fácil de saltarse (un atajo que se nos
/// escape, un `invoke` desde la consola, un fallo de la propia UI). Quien decide
/// si se toca el disco es el backend; Angular solo lo refleja.
fn exigir_escritura(bovedas: &Bovedas, id: Option<&str>) -> Result<(), String> {
    let boveda = bovedas.activa();
    if boveda.solo_lectura {
        return Err(
            "Esta bóveda es de solo lectura: el cuaderno es de otra persona y no se puede \
             modificar desde aquí."
                .to_string(),
        );
    }
    if boveda.soy_dueno {
        return Ok(());
    }
    // La marca que vale es la que hay EN DISCO, no la que llegue del webview:
    // si no, bastaría con mandar `bloqueada: false` para saltarse el candado.
    if let Some(id) = id {
        if bovedas.almacen().leer(id)?.is_some_and(|d| d.bloqueada) {
            return Err(
                "Esta nota está bloqueada por quien comparte la bóveda: puedes leerla, \
                 pero no cambiarla ni borrarla."
                    .to_string(),
            );
        }
    }
    Ok(())
}

/// Escribe `notas/<id>.json` y actualiza el índice.
/// Angular: `invoke('guardar_documento', { documento })`
#[tauri::command]
pub fn guardar_documento(
    bovedas: State<'_, Bovedas>,
    mut documento: Documento,
) -> Result<Documento, String> {
    exigir_escritura(&bovedas, documento.id.as_deref())?;
    // El candado solo lo mueve el dueño. Para todos los demás se conserva lo que
    // haya en disco, así que un `bloqueada: false` enviado a mano no desbloquea.
    if !bovedas.activa().soy_dueno {
        documento.bloqueada = documento
            .id
            .as_deref()
            .and_then(|id| bovedas.almacen().leer(id).ok().flatten())
            .is_some_and(|d| d.bloqueada);
    }
    bovedas.almacen().guardar(&bovedas.db(), documento)
}

/// Lee la nota del **fichero**, no del índice: es la fuente de verdad, así que
/// abrir un documento devuelve lo que hay en disco aunque el índice se haya
/// quedado atrás (por ejemplo si acaban de llegar cambios de otro equipo).
/// Angular: `invoke('obtener_documento', { id })`
#[tauri::command]
pub fn obtener_documento(
    bovedas: State<'_, Bovedas>,
    id: String,
) -> Result<Option<Documento>, String> {
    bovedas.almacen().leer(&id)
}

/// Angular: `invoke('listar_documentos')`
#[tauri::command]
pub fn listar_documentos(bovedas: State<'_, Bovedas>) -> Result<Vec<DocumentoResumen>, String> {
    bovedas.db().listar()
}

/// Angular: `invoke('eliminar_documento', { id })`
#[tauri::command]
pub fn eliminar_documento(bovedas: State<'_, Bovedas>, id: String) -> Result<(), String> {
    exigir_escritura(&bovedas, Some(&id))?;
    bovedas.almacen().eliminar(&bovedas.db(), &id)
}

/// Relee `notas/` y rehace el índice. Es lo que hay que llamar tras traer
/// cambios de otro equipo (`git pull`, Syncthing) sin cerrar la app. Devuelve
/// cuántas notas hay ahora en el workspace.
/// Angular: `invoke('recargar_workspace')`
#[tauri::command]
pub fn recargar_workspace(bovedas: State<'_, Bovedas>) -> Result<usize, String> {
    let (db, almacen) = (bovedas.db(), bovedas.almacen());
    let n = almacen.reconstruir(&db)?;
    db.reconstruir_assets(&bovedas.ruta().join("assets"))?;
    Ok(n)
}

/// Búsqueda de texto completo (FTS5).
/// Angular: `invoke('buscar_documentos', { consulta })`
#[tauri::command]
pub fn buscar_documentos(
    bovedas: State<'_, Bovedas>,
    consulta: String,
) -> Result<Vec<ResultadoBusqueda>, String> {
    bovedas.db().buscar(&consulta)
}

/// Todas las etiquetas con su número de usos.
/// Angular: `invoke('listar_etiquetas')`
#[tauri::command]
pub fn listar_etiquetas(bovedas: State<'_, Bovedas>) -> Result<Vec<TagInfo>, String> {
    bovedas.db().listar_tags()
}

// ============================================================ bóvedas

/// Bóvedas registradas en este equipo.
/// Angular: `invoke('listar_bovedas')`
#[tauri::command]
pub fn listar_bovedas(bovedas: State<'_, Bovedas>) -> Vec<Boveda> {
    bovedas.listar()
}

/// La bóveda abierta ahora mismo.
/// Angular: `invoke('boveda_activa')`
#[tauri::command]
pub fn boveda_activa(bovedas: State<'_, Bovedas>) -> Boveda {
    bovedas.activa()
}

/// Crea una bóveda vacía y cambia a ella. Para conectar una compartida: crear
/// aquí y después `conectar_repo` con la URL del repositorio de la otra persona.
/// Angular: `invoke('crear_boveda', { nombre })`
#[tauri::command]
pub fn crear_boveda(bovedas: State<'_, Bovedas>, nombre: String) -> Result<Boveda, String> {
    bovedas.crear(&nombre)
}

/// Cambia de bóveda. **Quien llame a esto desde la UI tiene que haber vaciado
/// antes el guardado pendiente**: el autoguardado va con temporizador y si salta
/// después del cambio, la nota se escribiría en la bóveda equivocada.
/// Angular: `invoke('cambiar_boveda', { id })`
#[tauri::command]
pub fn cambiar_boveda(bovedas: State<'_, Bovedas>, id: String) -> Result<Boveda, String> {
    bovedas.cambiar(&id)
}

/// Quita una bóveda de la lista **sin borrar sus ficheros**.
/// Angular: `invoke('olvidar_boveda', { id })`
#[tauri::command]
pub fn olvidar_boveda(bovedas: State<'_, Bovedas>, id: String) -> Result<(), String> {
    bovedas.olvidar(&id)
}

/// Cambia el nombre visible de una bóveda (no mueve su carpeta).
/// Angular: `invoke('renombrar_boveda', { id, nombre })`
#[tauri::command]
pub fn renombrar_boveda(
    bovedas: State<'_, Bovedas>,
    id: String,
    nombre: String,
) -> Result<Boveda, String> {
    bovedas.renombrar(&id, &nombre)
}

// ============================================================ cuenta de GitHub

/// Usuario con la sesión iniciada, o `null`. Valida el token contra GitHub, así
/// que también detecta que el usuario haya revocado el acceso desde la web.
/// Angular: `invoke('github_sesion')`
#[tauri::command]
pub async fn github_sesion(sesion: State<'_, Sesion>) -> Result<Option<UsuarioGitHub>, String> {
    let Some(token) = github::leer_token() else {
        return Ok(None);
    };
    match github::usuario(&token).await {
        Ok(u) => {
            sesion.recordar(&u);
            Ok(Some(u))
        }
        // Token caducado o revocado: se limpia para que la UI ofrezca entrar de
        // nuevo en vez de dar error en cada sincronización.
        Err(_) => {
            let _ = github::borrar_token();
            sesion.olvidar();
            Ok(None)
        }
    }
}

/// Paso 1 del device flow: devuelve el código que el usuario teclea en GitHub.
/// Angular: `invoke('github_iniciar_sesion')`
#[tauri::command]
pub async fn github_iniciar_sesion(
    sesion: State<'_, Sesion>,
) -> Result<CodigoDispositivo, String> {
    github::pedir_codigo(&sesion).await
}

/// Paso 2: espera a que el usuario apruebe en el navegador. Puede tardar
/// minutos; la UI enseña el código mientras tanto.
/// Angular: `invoke('github_esperar_aprobacion')`
#[tauri::command]
pub async fn github_esperar_aprobacion(sesion: State<'_, Sesion>) -> Result<UsuarioGitHub, String> {
    let u = github::esperar_aprobacion(&sesion).await?;
    sesion.recordar(&u);
    Ok(u)
}

/// Cierra la sesión. **No** toca las notas ni el repositorio local: el usuario
/// puede volver a entrar y seguir donde estaba.
/// Angular: `invoke('github_cerrar_sesion')`
#[tauri::command]
pub async fn github_cerrar_sesion(sesion: State<'_, Sesion>) -> Result<(), String> {
    sesion.olvidar();
    github::borrar_token()
}

/// Repositorios del usuario, para elegir cuál conectar en el segundo equipo.
/// Angular: `invoke('github_listar_repos')`
#[tauri::command]
pub async fn github_listar_repos() -> Result<Vec<RepoGitHub>, String> {
    let token = github::leer_token().ok_or("no has iniciado sesión en GitHub")?;
    github::listar_repos(&token).await
}

// ============================================================ secretos

/// ¿Tiene esta bóveda contraseña maestra, y está abierta ahora mismo?
/// Angular: `invoke('estado_secretos')`
#[tauri::command]
pub fn estado_secretos(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
) -> EstadoSecretos {
    secretos.estado(&bovedas.ruta())
}

/// Fija la contraseña maestra de la bóveda (solo la primera vez).
/// Angular: `invoke('configurar_secretos', { contrasena })`
#[tauri::command]
pub fn configurar_secretos(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
    contrasena: String,
) -> Result<(), String> {
    exigir_escritura(&bovedas, None)?;
    secretos.configurar(&bovedas.ruta(), &contrasena)
}

/// Angular: `invoke('desbloquear_secretos', { contrasena })`
#[tauri::command]
pub fn desbloquear_secretos(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
    contrasena: String,
) -> Result<(), String> {
    exigir_acceso(&bovedas)?;
    secretos.desbloquear(&bovedas.ruta(), &contrasena)
}

/// Los secretos de una bóveda a la que ya no tienes acceso no se abren.
///
/// **Es una barandilla, no una garantía**: el cifrado y la sal siguen en el
/// disco, así que con la contraseña maestra se pueden descifrar fuera de la app.
/// Lo que de verdad deja fuera a quien salió del equipo es que el dueño **rote
/// la contraseña**, porque los valores nuevos ya no los abre.
fn exigir_acceso(bovedas: &Bovedas) -> Result<(), String> {
    if bovedas.activa().sin_acceso {
        return Err(
            "Ya no tienes acceso al repositorio de esta bóveda, así que sus bloques cifrados \
             no se pueden abrir desde la app."
                .to_string(),
        );
    }
    Ok(())
}

/// Angular: `invoke('bloquear_secretos')`
#[tauri::command]
pub fn bloquear_secretos(secretos: State<'_, Secretos>) {
    secretos.bloquear();
}

/// Cifra un valor para meterlo en un bloque `secreto`.
/// Angular: `invoke('cifrar_secreto', { texto })`
#[tauri::command]
pub fn cifrar_secreto(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
    texto: String,
) -> Result<String, String> {
    exigir_acceso(&bovedas)?;
    secretos.cifrar(&texto)
}

/// Angular: `invoke('descifrar_secreto', { datos })`
#[tauri::command]
pub fn descifrar_secreto(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
    datos: String,
) -> Result<String, String> {
    exigir_acceso(&bovedas)?;
    secretos.descifrar(&datos)
}

/// Cambia la contraseña maestra y recifra todos los bloques.
///
/// Es lo que se hace cuando alguien deja el equipo. **No le quita lo que ya
/// vio**, ni el clon del repositorio que tenga con el cifrado viejo: para eso
/// hay que cambiar las credenciales de verdad y quitarle el acceso al
/// repositorio. Lo que consigue es que lo nuevo quede fuera de su alcance.
/// Angular: `invoke('rotar_clave_maestra', { actual, nueva })`
#[tauri::command]
pub fn rotar_clave_maestra(
    bovedas: State<'_, Bovedas>,
    secretos: State<'_, Secretos>,
    actual: String,
    nueva: String,
) -> Result<usize, String> {
    exigir_escritura(&bovedas, None)?;
    let (db, almacen) = (bovedas.db(), bovedas.almacen());

    // `rotar` descifra todo primero y solo escribe si nada falla, así que aquí
    // ya solo llegan notas que se pueden guardar sin miedo.
    let docs = almacen.listar_todos()?;
    let cambiadas = secretos.rotar(&bovedas.ruta(), &actual, &nueva, &docs)?;
    let n = cambiadas.len();
    for doc in cambiadas {
        almacen.guardar(&db, doc)?;
    }
    Ok(n)
}

// ============================================================ sincronización

/// Núcleo de la sincronización, compartido por los tres botones de la pantalla
/// (crear repositorio, conectar con uno existente y sincronizar ahora).
///
/// El orden es siempre `confirmar → traer → empujar`; ver la cabecera de
/// `sincro.rs` para por qué no puede ser otro.
async fn sincronizar_todo(
    bovedas: &Bovedas,
    secretos: &Secretos,
    autor: (String, String),
    sesion_login: Option<String>,
    url: Option<String>,
) -> Result<ResultadoSincro, String> {
    let token = github::leer_token().ok_or("no has iniciado sesión en GitHub")?;
    let mensaje = format!("Notas · {}", chrono::Local::now().format("%Y-%m-%d %H:%M"));
    let ws = bovedas.ruta();
    let boveda = bovedas.activa();

    // Bóveda marcada como perdida: no se reintenta en cada guardado. Solo se
    // vuelve a mirar si el usuario pide sincronizar a mano (`url` es None pero
    // viene de un botón) — para eso está `comprobar_acceso`.
    if boveda.sin_acceso && url.is_none() {
        return Err("ya no tienes acceso al repositorio de esta bóveda".into());
    }

    // Al conectar se decide si la bóveda es editable, y el criterio es la
    // permiso real de GitHub para la bóveda entera, y la PROPIEDAD para el
    // candado por nota. Un colaborador de un repo personal edita y crea; lo que
    // no puede tocar son las notas que el dueño haya bloqueado.
    if let Some(u) = &url {
        match github::repo_por_url(&token, u).await {
            Ok(r) => {
                let login = match sesion_login {
                    Some(l) => l,
                    None => github::usuario(&token).await?.login,
                };
                // Dos cosas distintas: si GitHub deja empujar (si no, la bóveda
                // entera es un espejo) y si el repositorio es tuyo (el dueño es
                // quien pone los candados y quien restaura lo que otro cambie).
                bovedas.marcar_sin_acceso(&boveda.id, false)?;
                bovedas.marcar_solo_lectura(&boveda.id, !r.escritura)?;
                let dueno = github::es_mio(&r, &login);
                bovedas.marcar_dueno(&boveda.id, dueno)?;
                if !dueno {
                    log::info!(
                        "«{}» es de {}: las notas bloqueadas serán de solo lectura",
                        r.completo,
                        r.propietario
                    );
                }
            }
            // Si GitHub no contesta, no se bloquea la conexión: un push fallido
            // más tarde degradará la bóveda solo.
            Err(e) => log::warn!("no se pudieron leer los permisos del repo: {e}"),
        }
    }
    // URL con la que preguntar si perdimos el acceso: la que se está conectando
    // o, si no, la que ya tenía el repositorio.
    let remoto_actual = url.clone().or_else(|| sincro::estado(&ws).remoto);
    let solo_lectura = bovedas.activa().solo_lectura;
    let soy_dueno = bovedas.activa().soy_dueno;

    // El dueño se guarda una copia de sus notas bloqueadas ANTES de traer nada:
    // es lo que le permite devolverlas a su sitio si alguien las ha cambiado por
    // fuera de la app. Sin esto el candado sería solo un acuerdo de caballeros.
    let bloqueadas = if soy_dueno {
        bovedas.almacen().instantanea_bloqueadas()?
    } else {
        Default::default()
    };
    let almacen_restaurar = bovedas.almacen();

    // `git2::Repository` no es Send: todo el trabajo del repositorio ocurre en
    // un hilo de bloqueo y nada de git cruza un `await`.
    let destino = ws.clone();
    // El original se mueve al hilo de bloqueo; esta copia queda para preguntarle
    // a la API si el fallo fue una pérdida de acceso.
    let token_api = token.clone();
    type Salida = (sincro::Traido, Vec<crate::almacen::NotaRestaurada>, bool);
    let resultado = tauri::async_runtime::spawn_blocking(
        move || -> Result<Salida, String> {
            let repo = sincro::abrir_o_iniciar(&destino)?;
            // Antes del primer commit, para que `workspace.db` nunca entre.
            almacen::escribir_gitignore(&destino)?;
            if let Some(u) = &url {
                sincro::fijar_remoto(&repo, u)?;
            }

            // Bóveda de solo lectura: es un ESPEJO. Ni se confirma ni se empuja;
            // se trae y se descarta lo local. Fusionar aquí generaría conflictos
            // en cada sincronización que el usuario no podría resolver nunca,
            // porque no tiene permiso para subir su versión.
            if solo_lectura {
                return Ok((sincro::espejar(&repo, &token, &destino)?, vec![], false));
            }

            sincro::confirmar(&repo, &mensaje, &autor.0, &autor.1)?;
            let traido = sincro::traer(&repo, &token, &destino, &autor.0, &autor.1)?;

            // Ya con los cambios de fuera en disco: lo que tocaron y no debían,
            // vuelve a su sitio y se confirma como un cambio más.
            let mut restauradas = Vec::new();
            if traido.cambios && !bloqueadas.is_empty() {
                restauradas = almacen_restaurar.restaurar_bloqueadas(&bloqueadas)?;
                if !restauradas.is_empty() {
                    log::info!("{} nota(s) bloqueada(s) restaurada(s)", restauradas.len());
                    sincro::confirmar(
                        &repo,
                        "Restaurar notas bloqueadas",
                        &autor.0,
                        &autor.1,
                    )?;
                }
            }

            match sincro::empujar(&repo, &token) {
                Ok(()) => Ok((traido, restauradas, false)),
                // El dueño puede haber quitado el permiso de escritura después
                // de conectar la bóveda: se degrada sola en vez de dar el mismo
                // error en cada guardado.
                Err(e) if sincro::es_falta_de_permiso(&e) => Ok((traido, restauradas, true)),
                Err(e) => Err(e),
            }
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Si git falló, se le pregunta a la API por qué. Un 404 con la sesión viva
    // es la señal inequívoca de que te han sacado del repositorio; un fallo de
    // red no dice nada y no debe marcar nada.
    let (traido, restauradas, rechazado) = match resultado {
        Ok(v) => v,
        Err(e) => {
            if let Some(u) = &remoto_actual {
                if matches!(
                    github::consultar_repo(&token_api, u).await,
                    Err((_, github::FalloRepo::NoVisible))
                ) {
                    bovedas.marcar_sin_acceso(&boveda.id, true)?;
                    // Y se cierra el candado: los secretos de una bóveda perdida
                    // no se abren desde la app.
                    secretos.bloquear();
                    return Err("ya no tienes acceso al repositorio de esta bóveda".into());
                }
            }
            return Err(e);
        }
    };

    if rechazado {
        log::info!("sin permiso de escritura: la bóveda pasa a solo lectura");
        bovedas.marcar_solo_lectura(&boveda.id, true)?;
    }
    let (db, almacen) = (bovedas.db(), bovedas.almacen());

    // Si llegó algo de fuera, el índice se ha quedado atrás.
    let notas = if traido.cambios {
        let n = almacen.reconstruir(&db)?;
        db.reconstruir_assets(&ws.join("assets"))?;
        n
    } else {
        db.listar()?.len()
    };

    Ok(ResultadoSincro {
        cambios: traido.cambios,
        conflictos: traido.conflictos,
        restauradas,
        notas,
    })
}

/// Crea el repositorio en GitHub (**siempre privado**) y sube las notas de este
/// equipo. Es el botón del **primer** equipo, el que ya tiene notas escritas.
/// Angular: `invoke('crear_repo', { nombre })`
#[tauri::command]
pub async fn crear_repo(
    bovedas: State<'_, Bovedas>,
    sesion: State<'_, Sesion>,
    secretos: State<'_, Secretos>,
    nombre: String,
) -> Result<RepoGitHub, String> {
    let token = github::leer_token().ok_or("no has iniciado sesión en GitHub")?;
    let repo = github::crear_repo(&token, &nombre).await?;
    sincronizar_todo(&bovedas, &secretos, sesion.autor(), sesion.login(), Some(repo.url.clone()))
        .await?;
    Ok(repo)
}

/// Conecta este equipo con un repositorio que ya existe y trae las notas. Es el
/// botón del **segundo** equipo. Si aquí ya había notas escritas, no se pierden:
/// se fusionan (los ficheros van por UUID, no pueden chocar).
/// Angular: `invoke('conectar_repo', { url })`
#[tauri::command]
pub async fn conectar_repo(
    bovedas: State<'_, Bovedas>,
    sesion: State<'_, Sesion>,
    secretos: State<'_, Secretos>,
    url: String,
) -> Result<ResultadoSincro, String> {
    sincronizar_todo(&bovedas, &secretos, sesion.autor(), sesion.login(), Some(url)).await
}

/// Sincroniza ahora. Es lo que llama el botón manual y también el automatismo
/// (al arrancar y tras el autoguardado).
/// Angular: `invoke('sincronizar')`
#[tauri::command]
pub async fn sincronizar(
    bovedas: State<'_, Bovedas>,
    sesion: State<'_, Sesion>,
    secretos: State<'_, Secretos>,
) -> Result<ResultadoSincro, String> {
    sincronizar_todo(&bovedas, &secretos, sesion.autor(), sesion.login(), None).await
}

/// Vuelve a preguntar a GitHub si sigues teniendo acceso a esta bóveda. Sirve
/// para levantar la marca cuando el dueño te vuelve a invitar.
/// Angular: `invoke('comprobar_acceso')`
#[tauri::command]
pub async fn comprobar_acceso(bovedas: State<'_, Bovedas>) -> Result<bool, String> {
    let boveda = bovedas.activa();
    let Some(url) = sincro::estado(&bovedas.ruta()).remoto else {
        return Ok(true); // sin remoto no hay acceso que perder
    };
    let token = github::leer_token().ok_or("no has iniciado sesión en GitHub")?;

    match github::consultar_repo(&token, &url).await {
        Ok(_) => {
            bovedas.marcar_sin_acceso(&boveda.id, false)?;
            Ok(true)
        }
        Err((_, github::FalloRepo::NoVisible)) => {
            bovedas.marcar_sin_acceso(&boveda.id, true)?;
            Ok(false)
        }
        // Sin red no se sabe: no se toca la marca en ningún sentido.
        Err((e, _)) => Err(e),
    }
}

/// Estado del repositorio local, sin tocar la red.
/// Angular: `invoke('estado_sincro')`
#[tauri::command]
pub fn estado_sincro(bovedas: State<'_, Bovedas>) -> Result<EstadoSincro, String> {
    Ok(sincro::estado(&bovedas.ruta()))
}

/// Desconecta el workspace del repositorio remoto. Las notas y el historial
/// local se quedan intactos; solo deja de sincronizarse.
/// Angular: `invoke('desconectar_repo')`
#[tauri::command]
pub fn desconectar_repo(bovedas: State<'_, Bovedas>) -> Result<(), String> {
    let repo = sincro::abrir_o_iniciar(&bovedas.ruta())?;
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Lógica común: guarda `bytes` en el `assets/` de la **bóveda activa** con
/// nombre por hash de contenido, lo registra en la tabla `asset` y devuelve su
/// ruta absoluta.
///
/// La carpeta llega por parámetro y no se resuelve aquí a propósito: con una
/// ruta fija, una imagen pegada en la bóveda compartida se escribiría en la
/// personal y la nota apuntaría a un fichero que los demás nunca reciben.
fn escribir_asset(dir: &Path, db: &Db, bytes: &[u8], ext: &str) -> Result<AssetGuardado, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    let ext = if ext.is_empty() { "bin".to_string() } else { ext };
    let nombre = format!("{hash}.{ext}");

    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let ruta = dir.join(&nombre);
    if !ruta.exists() {
        fs::write(&ruta, bytes).map_err(|e| e.to_string())?;
    }

    let id = db.guardar_asset(&ext, &nombre, &hash)?;
    let preview = generar_preview(dir, &hash, bytes, &ext);

    Ok(AssetGuardado {
        id,
        nombre,
        ruta: ruta.to_string_lossy().into_owned(),
        preview,
    })
}

/// Guarda un asset a partir de sus bytes en base64 (imagen pegada como bytes).
/// Angular: `invoke('guardar_asset', { datosBase64, ext })`
#[tauri::command]
pub fn guardar_asset(
    bovedas: State<'_, Bovedas>,
    datos_base64: String,
    ext: String,
) -> Result<AssetGuardado, String> {
    exigir_escritura(&bovedas, None)?;
    let bytes = general_purpose::STANDARD
        .decode(datos_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    escribir_asset(&bovedas.ruta().join("assets"), &bovedas.db(), &bytes, &ext)
}

/// Lee una imagen del disco SIN guardarla como asset: sus bytes viajan al
/// webview para poder editarla (anotarla) antes de decidir qué se guarda.
///
/// No se usa `convertFileSrc` para esto porque la imagen acaba dibujándose en un
/// `<canvas>` y exportándose: si viniera del protocolo `asset://` (otro origen),
/// el lienzo quedaría "tainted" y `toDataURL()` fallaría. Con los bytes en mano
/// se crea un blob del mismo origen y el problema no existe.
///
/// Angular: `invoke('leer_imagen', { ruta })`
#[tauri::command]
pub fn leer_imagen(ruta: String) -> Result<ImagenLeida, String> {
    let bytes = fs::read(&ruta).map_err(|e| format!("No se pudo leer {ruta}: {e}"))?;
    let ext = Path::new(&ruta)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    Ok(ImagenLeida {
        datos: general_purpose::STANDARD.encode(&bytes),
        ext,
    })
}

/// Importa un asset leyendo un fichero del disco (imagen copiada desde el
/// explorador → se pega su ruta).
/// Angular: `invoke('importar_asset', { ruta })`
#[tauri::command]
pub fn importar_asset(
    bovedas: State<'_, Bovedas>,
    ruta: String,
) -> Result<AssetGuardado, String> {
    exigir_escritura(&bovedas, None)?;
    let bytes = fs::read(&ruta).map_err(|e| format!("No se pudo leer {ruta}: {e}"))?;
    let ext = Path::new(&ruta)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    escribir_asset(&bovedas.ruta().join("assets"), &bovedas.db(), &bytes, ext)
}
