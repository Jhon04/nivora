//! Sincronización del workspace por git.
//!
//! Usa **libgit2 embebido** (`git2`), no el `git` del sistema: la app se instala
//! en equipos donde git puede no existir, y el primer paso del usuario no puede
//! ser abrir una terminal.
//!
//! El orden de una sincronización es siempre el mismo y **no es negociable**:
//!
//! ```text
//! confirmar()  →  traer()  →  empujar()
//! ```
//!
//! Confirmar primero deja el árbol de trabajo limpio, y a partir de ahí todo lo
//! que hace git es a nivel de commits: la fusión ya no puede pisar un fichero sin
//! guardar. Si se trajera antes de confirmar, un `checkout` se llevaría por
//! delante lo que el usuario acabara de escribir.
//!
//! Los conflictos se resuelven por fecha (ver `resolver_conflictos`) porque un
//! merge a tres bandas sobre el JSON de Tiptap puede producir un fichero
//! **inválido**, y eso sí sería perder la nota entera.

use std::path::{Path, PathBuf};

use git2::{
    build::CheckoutBuilder, Cred, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks,
    Repository, RepositoryInitOptions, Signature,
};
use serde::{Deserialize, Serialize};

/// Rama única del workspace. No hay ramas de trabajo: esto es un cuaderno, no
/// un proyecto de código.
pub const RAMA: &str = "main";

/// Resultado de traer cambios del remoto.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Traido {
    /// ¿Llegó algo nuevo? Si es `true` hay que reconstruir el índice.
    pub cambios: bool,
    /// Notas que venían editadas en los dos equipos. Se guardó la más reciente y
    /// la otra quedó como `<id>.conflicto-<fecha>.json`.
    pub conflictos: Vec<String>,
}

/// Lo que devuelve una sincronización completa.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultadoSincro {
    /// ¿Llegó algo del otro equipo?
    pub cambios: bool,
    /// Notas que se editaron en dos sitios a la vez: se guardó la más reciente y
    /// la otra quedó como `<id>.conflicto-<fecha>.json`.
    pub conflictos: Vec<String>,
    /// Notas **bloqueadas** que alguien cambió y han vuelto a su sitio. Es otra
    /// cosa que un conflicto y merece un aviso distinto: aquí alguien tocó algo
    /// que no debía.
    pub restauradas: Vec<crate::almacen::NotaRestaurada>,
    /// Notas que hay ahora en el workspace.
    pub notas: usize,
}

/// Estado que la pantalla de configuración necesita pintar.
// `camelCase` porque esto cruza a TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstadoSincro {
    /// ¿El workspace es ya un repositorio git?
    pub iniciado: bool,
    /// URL del remoto `origin`, si lo hay.
    pub remoto: Option<String>,
    /// Cambios sin confirmar en el árbol de trabajo.
    pub pendientes: usize,
    /// Fecha del último commit (RFC 3339).
    pub ultimo_commit: Option<String>,
}

/// Credenciales para GitHub por HTTPS. El token va de contraseña; el usuario da
/// igual, pero `x-access-token` es el que GitHub documenta y vale tanto para
/// tokens de OAuth como de instalación.
fn credenciales(token: &str) -> RemoteCallbacks<'static> {
    let token = token.to_string();
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, _usuario, _tipos| Cred::userpass_plaintext("x-access-token", &token));
    cb
}

/// Abre el repositorio del workspace, creándolo si aún no existe. La rama
/// inicial se fuerza a `main` para no depender del `init.defaultBranch` de cada
/// equipo (unos crean `master` y otros `main`, y luego el push no cuadra).
pub fn abrir_o_iniciar(workspace: &Path) -> Result<Repository, String> {
    if let Ok(repo) = Repository::open(workspace) {
        return Ok(repo);
    }
    let mut opciones = RepositoryInitOptions::new();
    opciones.initial_head(RAMA);
    Repository::init_opts(workspace, &opciones).map_err(|e| e.to_string())
}

/// Apunta `origin` a `url`, reemplazándolo si ya existía (el usuario puede
/// reconectar el workspace a otro repositorio).
pub fn fijar_remoto(repo: &Repository, url: &str) -> Result<(), String> {
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin").map_err(|e| e.to_string())?;
    }
    repo.remote("origin", url).map_err(|e| e.to_string())?;
    Ok(())
}

fn firma<'a>(nombre: &str, correo: &str) -> Result<Signature<'a>, String> {
    Signature::now(nombre, correo).map_err(|e| e.to_string())
}

/// Añade todo lo que no esté ignorado y confirma. Devuelve `false` si no había
/// nada que confirmar (el caso normal: el autoguardado dispara mucho más a
/// menudo de lo que el usuario cambia cosas).
pub fn confirmar(
    repo: &Repository,
    mensaje: &str,
    nombre: &str,
    correo: &str,
) -> Result<bool, String> {
    let mut indice = repo.index().map_err(|e| e.to_string())?;
    // `DEFAULT` respeta el .gitignore del workspace, que es donde queda excluido
    // `workspace.db`.
    indice
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    indice.write().map_err(|e| e.to_string())?;

    let arbol_id = indice.write_tree().map_err(|e| e.to_string())?;
    let arbol = repo.find_tree(arbol_id).map_err(|e| e.to_string())?;
    let padre = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    // Si el árbol es idéntico al del último commit, no hay nada que guardar.
    if let Some(p) = &padre {
        if p.tree_id() == arbol_id {
            return Ok(false);
        }
    }

    let firma = firma(nombre, correo)?;
    let padres: Vec<&git2::Commit> = padre.iter().collect();
    repo.commit(Some("HEAD"), &firma, &firma, mensaje, &arbol, &padres)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Trae del remoto y fusiona. Presupone el árbol de trabajo limpio (ver el
/// comentario de cabecera del módulo).
pub fn traer(
    repo: &Repository,
    token: &str,
    workspace: &Path,
    nombre: &str,
    correo: &str,
) -> Result<Traido, String> {
    let mut remoto = repo
        .find_remote("origin")
        .map_err(|_| "el workspace no está conectado a ningún repositorio".to_string())?;

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(credenciales(token));
    // Un repositorio recién creado en GitHub no tiene la rama todavía; eso no es
    // un error, simplemente no hay nada que traer.
    if let Err(e) = remoto.fetch(&[RAMA], Some(&mut fo), None) {
        if e.code() == git2::ErrorCode::NotFound {
            return Ok(Traido::default());
        }
        return Err(e.to_string());
    }

    let cabeza = match repo.find_reference("FETCH_HEAD") {
        Ok(r) => r,
        Err(_) => return Ok(Traido::default()),
    };
    let entrante = repo
        .reference_to_annotated_commit(&cabeza)
        .map_err(|e| e.to_string())?;
    let (analisis, _) = repo.merge_analysis(&[&entrante]).map_err(|e| e.to_string())?;

    if analisis.is_up_to_date() {
        return Ok(Traido::default());
    }

    // Equipo nuevo: aquí no hay ni un commit, así que la rama local pasa a ser
    // la remota y se sacan los ficheros. Es el "clonar" del segundo equipo.
    if analisis.is_unborn() {
        repo.reference(
            &format!("refs/heads/{RAMA}"),
            entrante.id(),
            true,
            "primera sincronización",
        )
        .map_err(|e| e.to_string())?;
        repo.set_head(&format!("refs/heads/{RAMA}")).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;
        return Ok(Traido { cambios: true, conflictos: vec![] });
    }

    if analisis.is_fast_forward() {
        let mut referencia = repo
            .find_reference(&format!("refs/heads/{RAMA}"))
            .map_err(|e| e.to_string())?;
        referencia
            .set_target(entrante.id(), "avance rápido")
            .map_err(|e| e.to_string())?;
        repo.set_head(&format!("refs/heads/{RAMA}")).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;
        return Ok(Traido { cambios: true, conflictos: vec![] });
    }

    // Fusión de verdad: los dos equipos han escrito. Incluye el caso de
    // historias sin ancestro común (el segundo equipo ya tenía notas antes de
    // conectarse), que aquí no es un problema porque las notas se llaman por
    // UUID y no pueden chocar.
    repo.merge(&[&entrante], None, Some(CheckoutBuilder::new().force()))
        .map_err(|e| e.to_string())?;

    let conflictos = resolver_conflictos(repo, workspace)?;

    let mut indice = repo.index().map_err(|e| e.to_string())?;
    let arbol_id = indice.write_tree().map_err(|e| e.to_string())?;
    let arbol = repo.find_tree(arbol_id).map_err(|e| e.to_string())?;
    let firma = firma(nombre, correo)?;
    let local = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let remoto_commit = repo.find_commit(entrante.id()).map_err(|e| e.to_string())?;
    repo.commit(
        Some("HEAD"),
        &firma,
        &firma,
        "Fusionar cambios de otro equipo",
        &arbol,
        &[&local, &remoto_commit],
    )
    .map_err(|e| e.to_string())?;
    repo.cleanup_state().map_err(|e| e.to_string())?;

    Ok(Traido { cambios: true, conflictos })
}

/// Resuelve los conflictos de fusión **por fecha**: gana el `modificado` más
/// reciente y la otra versión se guarda al lado como `<id>.conflicto-<fecha>.json`.
///
/// No se intenta fusionar el JSON: un merge a tres bandas sobre el árbol de
/// Tiptap puede dejar un fichero que ya no parsea, y entonces la nota se pierde
/// entera. Así nunca se pierde nada — el fichero de conflicto se queda en disco,
/// el indexador lo ignora (`almacen::es_copia_en_conflicto`) y la UI puede
/// ofrecer "esta nota tiene otra versión".
fn resolver_conflictos(repo: &Repository, workspace: &Path) -> Result<Vec<String>, String> {
    let mut indice = repo.index().map_err(|e| e.to_string())?;
    if !indice.has_conflicts() {
        return Ok(vec![]);
    }

    // Se recogen antes de tocar nada: el iterador toma prestado el índice y
    // luego hay que modificarlo.
    let pendientes: Vec<(PathBuf, Option<Vec<u8>>, Option<Vec<u8>>)> = {
        let conflictos = indice.conflicts().map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for c in conflictos {
            let c = c.map_err(|e| e.to_string())?;
            let ruta = c
                .our
                .as_ref()
                .or(c.their.as_ref())
                .map(|e| PathBuf::from(String::from_utf8_lossy(&e.path).into_owned()));
            let Some(ruta) = ruta else { continue };
            let leer = |e: &Option<git2::IndexEntry>| {
                e.as_ref()
                    .and_then(|e| repo.find_blob(e.id).ok())
                    .map(|b| b.content().to_vec())
            };
            v.push((ruta, leer(&c.our), leer(&c.their)));
        }
        v
    };

    let mut avisos = Vec::new();
    for (ruta, nuestro, suyo) in pendientes {
        let destino = workspace.join(&ruta);
        match (nuestro, suyo) {
            (Some(a), Some(b)) => {
                let (gana, pierde) = if fecha(&a) >= fecha(&b) { (a, b) } else { (b, a) };
                std::fs::write(&destino, &gana).map_err(|e| e.to_string())?;

                let marca = chrono::Utc::now().format("%Y%m%d-%H%M%S");
                let tallo = ruta.file_stem().map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "nota".into());
                let copia = ruta.with_file_name(format!("{tallo}.conflicto-{marca}.json"));
                std::fs::write(workspace.join(&copia), &pierde).map_err(|e| e.to_string())?;

                indice.add_path(&copia).map_err(|e| e.to_string())?;
                avisos.push(copia.to_string_lossy().into_owned());
            }
            // Editada en un lado y borrada en el otro: se conserva la que existe.
            // Ante la duda, no se borra el trabajo de nadie.
            (Some(a), None) | (None, Some(a)) => {
                std::fs::write(&destino, &a).map_err(|e| e.to_string())?;
            }
            (None, None) => continue,
        }
        indice.conflict_remove(&ruta).map_err(|e| e.to_string())?;
        indice.add_path(&ruta).map_err(|e| e.to_string())?;
    }
    indice.write().map_err(|e| e.to_string())?;
    Ok(avisos)
}

/// Fecha `modificado` de una nota serializada. Si el fichero no parsea devuelve
/// la cadena vacía, que ordena por debajo de cualquier fecha: así una versión
/// ilegible nunca le gana a una buena.
fn fecha(bytes: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("modificado").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_default()
}

/// Trae los cambios y **deja la carpeta idéntica al remoto**, descartando lo que
/// hubiera en local. Es la sincronización de una bóveda de **solo lectura**.
///
/// No se fusiona ni se confirma nada: la bóveda es un espejo del repositorio de
/// otra persona. Si se hiciera un merge normal, cualquier resto local iría
/// generando conflictos en cada sincronización, para siempre y sin que el
/// usuario pueda resolverlos (no tiene permiso para subir su versión).
///
/// La UI impide editar en estas bóvedas, así que no debería haber nada local que
/// perder — pero conviene saber que este camino **descarta**, no fusiona.
pub fn espejar(repo: &Repository, token: &str, workspace: &Path) -> Result<Traido, String> {
    let mut remoto = repo
        .find_remote("origin")
        .map_err(|_| "el workspace no está conectado a ningún repositorio".to_string())?;

    let mut fo = FetchOptions::new();
    fo.remote_callbacks(credenciales(token));
    if let Err(e) = remoto.fetch(&[RAMA], Some(&mut fo), None) {
        if e.code() == git2::ErrorCode::NotFound {
            return Ok(Traido::default());
        }
        return Err(e.to_string());
    }

    let Ok(cabeza) = repo.find_reference("FETCH_HEAD") else {
        return Ok(Traido::default());
    };
    let objetivo = repo
        .reference_to_annotated_commit(&cabeza)
        .map_err(|e| e.to_string())?
        .id();

    // Ya estamos en ese commit: nada que hacer (el caso normal).
    if repo.head().ok().and_then(|h| h.target()) == Some(objetivo) {
        return Ok(Traido::default());
    }

    let commit = repo.find_commit(objetivo).map_err(|e| e.to_string())?;
    repo.reset(commit.as_object(), git2::ResetType::Hard, None)
        .map_err(|e| e.to_string())?;
    repo.reference(&format!("refs/heads/{RAMA}"), objetivo, true, "espejo")
        .map_err(|e| e.to_string())?;
    repo.set_head(&format!("refs/heads/{RAMA}")).map_err(|e| e.to_string())?;

    // git no versiona directorios: si la bóveda remota se quedó sin notas, la
    // carpeta desaparece y la app tiene que poder seguir leyendo.
    let _ = std::fs::create_dir_all(workspace.join("notas"));

    Ok(Traido { cambios: true, conflictos: vec![] })
}

/// ¿Es este fallo de git una falta de permisos y no un problema de red?
///
/// Sirve para degradar la bóveda a solo lectura sola cuando el dueño le quita la
/// escritura al usuario después de haberla conectado.
pub fn es_falta_de_permiso(e: &str) -> bool {
    let e = e.to_lowercase();
    e.contains("403")
        || e.contains("permission")
        || e.contains("denied")
        || e.contains("unauthorized")
        || e.contains("write access")
        || e.contains("cannot push")
}

/// Empuja `main` al remoto y deja el seguimiento puesto.
pub fn empujar(repo: &Repository, token: &str) -> Result<(), String> {
    let mut remoto = repo
        .find_remote("origin")
        .map_err(|_| "el workspace no está conectado a ningún repositorio".to_string())?;
    let mut po = PushOptions::new();
    po.remote_callbacks(credenciales(token));
    remoto
        .push(&[&format!("refs/heads/{RAMA}:refs/heads/{RAMA}")], Some(&mut po))
        .map_err(|e| e.to_string())?;

    if let Ok(mut rama) = repo.find_branch(RAMA, git2::BranchType::Local) {
        let _ = rama.set_upstream(Some(&format!("origin/{RAMA}")));
    }
    Ok(())
}

/// Lo que la pantalla de configuración necesita saber sin tocar la red.
pub fn estado(workspace: &Path) -> EstadoSincro {
    let Ok(repo) = Repository::open(workspace) else {
        return EstadoSincro {
            iniciado: false,
            remoto: None,
            pendientes: 0,
            ultimo_commit: None,
        };
    };
    let remoto = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(String::from));
    let pendientes = repo
        .statuses(Some(git2::StatusOptions::new().include_untracked(true)))
        .map(|s| s.len())
        .unwrap_or(0);
    let ultimo_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| {
        chrono::DateTime::from_timestamp(c.time().seconds(), 0)
            .unwrap_or_default()
            .to_rfc3339()
    });
    EstadoSincro { iniciado: true, remoto, pendientes, ultimo_commit }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const AUTOR: (&str, &str) = ("Nota Local", "nota@local");

    /// Un "GitHub" de mentira: un repositorio desnudo en disco. Permite probar
    /// el ciclo completo (dos equipos, push, pull, conflictos) sin red y sin
    /// credenciales — el token que se pasa da igual porque `file://` no
    /// autentica.
    struct Escenario {
        raiz: PathBuf,
    }

    impl Escenario {
        fn nuevo() -> Self {
            let raiz = std::env::temp_dir().join(format!("sincro-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&raiz).unwrap();
            Repository::init_bare(raiz.join("remoto.git")).unwrap();
            Self { raiz }
        }

        fn url_remoto(&self) -> String {
            format!("file://{}", self.raiz.join("remoto.git").display())
        }

        /// Prepara el workspace de un equipo, con su carpeta `notas/`.
        fn equipo(&self, nombre: &str) -> PathBuf {
            let dir = self.raiz.join(nombre);
            fs::create_dir_all(dir.join("notas")).unwrap();
            dir
        }

        fn nota(&self, equipo: &Path, id: &str, titulo: &str, modificado: &str) {
            let doc = serde_json::json!({
                "id": id,
                "titulo": titulo,
                "tags": [],
                "contenido": { "type": "doc", "content": [] },
                "creado": "2026-01-01T00:00:00Z",
                "modificado": modificado,
            });
            fs::write(
                equipo.join("notas").join(format!("{id}.json")),
                serde_json::to_string_pretty(&doc).unwrap(),
            )
            .unwrap();
        }

        /// Títulos de las notas del equipo. Tolera que `notas/` no exista: git no
        /// versiona directorios, así que al borrarse la última nota la carpeta
        /// desaparece en el otro equipo.
        fn titulos(&self, equipo: &Path) -> Vec<String> {
            let Ok(entradas) = fs::read_dir(equipo.join("notas")) else {
                return vec![];
            };
            let mut v: Vec<String> = entradas
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
                .map(|e| {
                    let t: serde_json::Value =
                        serde_json::from_str(&fs::read_to_string(e.path()).unwrap()).unwrap();
                    t["titulo"].as_str().unwrap_or_default().to_string()
                })
                .collect();
            v.sort();
            v
        }
    }

    impl Drop for Escenario {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.raiz);
        }
    }

    /// Ciclo entero: confirmar → traer → empujar.
    fn sincronizar(ws: &Path, url: Option<&str>) -> Traido {
        let repo = abrir_o_iniciar(ws).unwrap();
        if let Some(u) = url {
            fijar_remoto(&repo, u).unwrap();
        }
        confirmar(&repo, "notas", AUTOR.0, AUTOR.1).unwrap();
        let traido = traer(&repo, "token-falso", ws, AUTOR.0, AUTOR.1).unwrap();
        empujar(&repo, "token-falso").unwrap();
        traido
    }

    #[test]
    fn el_portatil_sube_y_el_pc_se_las_trae() {
        let e = Escenario::nuevo();
        let portatil = e.equipo("portatil");
        let pc = e.equipo("pc");

        e.nota(&portatil, "11111111-1111-1111-1111-111111111111", "Lista de la compra", "2026-07-01T10:00:00Z");
        sincronizar(&portatil, Some(&e.url_remoto()));

        // El PC es una instalación nueva: sin notas y sin repositorio.
        let traido = sincronizar(&pc, Some(&e.url_remoto()));

        assert!(traido.cambios);
        assert_eq!(e.titulos(&pc), vec!["Lista de la compra".to_string()]);
    }

    #[test]
    fn las_notas_escritas_en_los_dos_equipos_se_juntan() {
        let e = Escenario::nuevo();
        let portatil = e.equipo("portatil");
        let pc = e.equipo("pc");

        e.nota(&portatil, "11111111-1111-1111-1111-111111111111", "Del portátil", "2026-07-01T10:00:00Z");
        sincronizar(&portatil, Some(&e.url_remoto()));

        // El PC ya tenía notas ANTES de conectarse: historias sin ancestro
        // común. Como los ficheros se llaman por UUID no pueden chocar, así que
        // deben sobrevivir las dos.
        e.nota(&pc, "22222222-2222-2222-2222-222222222222", "Del PC", "2026-07-01T11:00:00Z");
        sincronizar(&pc, Some(&e.url_remoto()));

        assert_eq!(e.titulos(&pc), vec!["Del PC".to_string(), "Del portátil".to_string()]);

        // Y el portátil recibe la del PC en su siguiente sincronización.
        sincronizar(&portatil, None);
        assert_eq!(e.titulos(&portatil), vec!["Del PC".to_string(), "Del portátil".to_string()]);
    }

    #[test]
    fn el_borrado_viaja_al_otro_equipo() {
        let e = Escenario::nuevo();
        let portatil = e.equipo("portatil");
        let pc = e.equipo("pc");
        let id = "11111111-1111-1111-1111-111111111111";

        e.nota(&portatil, id, "Efímera", "2026-07-01T10:00:00Z");
        sincronizar(&portatil, Some(&e.url_remoto()));
        sincronizar(&pc, Some(&e.url_remoto()));
        assert_eq!(e.titulos(&pc).len(), 1);

        fs::remove_file(portatil.join("notas").join(format!("{id}.json"))).unwrap();
        sincronizar(&portatil, None);
        sincronizar(&pc, None);

        // Que el fichero desaparezca ES la lápida: sin tabla de borrados.
        assert!(e.titulos(&pc).is_empty());

        // Y la app tiene que seguir pudiendo escribir aunque git se haya llevado
        // la carpeta vacía por delante (ver `Almacen::escribir`).
        let db = crate::db::Db::abrir(&pc.join("workspace.db")).unwrap();
        let al = crate::almacen::Almacen::nuevo(&pc.join("notas")).unwrap();
        fs::remove_dir_all(pc.join("notas")).ok();
        assert!(
            al.guardar(&db, crate::models::Documento {
                id: None,
                titulo: "Después del borrado".into(),
                icono: None,
                cover: None,
                tags: vec![],
                bloqueada: false,
                contenido: serde_json::json!({ "type": "doc", "content": [] }),
                creado: None,
                modificado: None,
            })
            .is_ok(),
            "guardar debe recrear notas/ si desapareció"
        );
    }

    #[test]
    fn la_misma_nota_editada_en_dos_sitios_conserva_las_dos_versiones() {
        let e = Escenario::nuevo();
        let portatil = e.equipo("portatil");
        let pc = e.equipo("pc");
        let id = "11111111-1111-1111-1111-111111111111";

        e.nota(&portatil, id, "Original", "2026-07-01T10:00:00Z");
        sincronizar(&portatil, Some(&e.url_remoto()));
        sincronizar(&pc, Some(&e.url_remoto()));

        // Los dos editan la misma nota sin sincronizar entre medias.
        e.nota(&portatil, id, "Versión del portátil", "2026-07-01T12:00:00Z");
        e.nota(&pc, id, "Versión del PC (más nueva)", "2026-07-01T13:00:00Z");
        sincronizar(&portatil, None);
        let traido = sincronizar(&pc, None);

        assert_eq!(traido.conflictos.len(), 1, "debería avisar de la versión en conflicto");

        // Gana la más reciente...
        let vigente: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(pc.join("notas").join(format!("{id}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(vigente["titulo"], "Versión del PC (más nueva)");

        // ...y la otra se queda al lado, sin perderse.
        let copia = fs::read_dir(pc.join("notas"))
            .unwrap()
            .flatten()
            .find(|f| f.file_name().to_string_lossy().contains("conflicto"))
            .expect("debería quedar la versión perdedora");
        let perdedora: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(copia.path()).unwrap()).unwrap();
        assert_eq!(perdedora["titulo"], "Versión del portátil");
    }

    #[test]
    fn confirmar_sin_cambios_no_crea_un_commit_vacio() {
        let e = Escenario::nuevo();
        let ws = e.equipo("portatil");
        e.nota(&ws, "11111111-1111-1111-1111-111111111111", "Una", "2026-07-01T10:00:00Z");

        let repo = abrir_o_iniciar(&ws).unwrap();
        assert!(confirmar(&repo, "primera", AUTOR.0, AUTOR.1).unwrap());
        // El autoguardado dispara mucho más a menudo de lo que el usuario cambia
        // cosas: sin esta comprobación el historial se llenaría de ruido.
        assert!(!confirmar(&repo, "otra vez", AUTOR.0, AUTOR.1).unwrap());
    }

    #[test]
    fn el_indice_no_se_versiona() {
        let e = Escenario::nuevo();
        let ws = e.equipo("portatil");
        e.nota(&ws, "11111111-1111-1111-1111-111111111111", "Una", "2026-07-01T10:00:00Z");
        fs::write(ws.join("workspace.db"), b"binario que no debe subir").unwrap();
        crate::almacen::escribir_gitignore(&ws).unwrap();

        let repo = abrir_o_iniciar(&ws).unwrap();
        confirmar(&repo, "primera", AUTOR.0, AUTOR.1).unwrap();

        let arbol = repo.head().unwrap().peel_to_commit().unwrap().tree().unwrap();
        assert!(arbol.get_name("workspace.db").is_none(), "workspace.db NO debe versionarse");
        assert!(arbol.get_name("notas").is_some());
    }

    #[test]
    fn el_estado_refleja_lo_que_hay_sin_tocar_la_red() {
        let e = Escenario::nuevo();
        let ws = e.equipo("portatil");

        assert!(!estado(&ws).iniciado, "todavía no es un repositorio");

        e.nota(&ws, "11111111-1111-1111-1111-111111111111", "Una", "2026-07-01T10:00:00Z");
        let repo = abrir_o_iniciar(&ws).unwrap();
        fijar_remoto(&repo, &e.url_remoto()).unwrap();

        let st = estado(&ws);
        assert!(st.iniciado);
        assert!(st.remoto.is_some());
        assert!(st.pendientes > 0, "la nota sin confirmar debería contar");
        assert!(st.ultimo_commit.is_none());

        confirmar(&repo, "primera", AUTOR.0, AUTOR.1).unwrap();
        let st = estado(&ws);
        assert_eq!(st.pendientes, 0);
        assert!(st.ultimo_commit.is_some());
    }
}
