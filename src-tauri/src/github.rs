//! Cuenta de GitHub: inicio de sesión y creación del repositorio.
//!
//! # Por qué Device Flow y no OAuth normal
//!
//! El OAuth web clásico necesita un `client_secret`, y en una app que la gente
//! se descarga **no existe forma de guardar un secreto**: está dentro del
//! binario. El Device Flow no lo usa — el usuario aprueba el acceso en
//! `github.com/login/device` escribiendo un código corto — así que no hace falta
//! ni servidor propio, ni redirección a `localhost`, ni navegador embebido. Es
//! lo que hace `gh auth login`.
//!
//! # El token nunca pasa por el webview
//!
//! Todas las llamadas salen de Rust. Angular solo se entera de "sesión iniciada
//! como *fulanito*"; el token vive en el llavero del sistema y no toca
//! JavaScript. Tampoco se guarda en el workspace, que acabaría subido al repo.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Client ID de la OAuth App (dato **público**, no es un secreto).
///
/// Se registra una vez en GitHub → Settings → Developer settings → OAuth Apps →
/// New OAuth App, y dentro hay que marcar **Enable Device Flow**. En desarrollo
/// se puede sobrescribir con la variable de entorno `NIVORA_CLIENT_ID`.
const CLIENT_ID: &str = "Ov23liH7C3x7BFeEoL5G";

/// Valor del marcador previo a configurar la OAuth App.
const SIN_CONFIGURAR: &str = "PON_AQUI_TU_CLIENT_ID";

/// Único permiso que se pide: crear el repositorio privado y empujar en él.
/// Nada de `user`, `workflow` ni `delete_repo`.
const AMBITO: &str = "repo";

const SERVICIO_LLAVERO: &str = "nivora";
const CUENTA_LLAVERO: &str = "github";

fn client_id() -> Result<String, String> {
    validar(&std::env::var("NIVORA_CLIENT_ID").unwrap_or_else(|_| CLIENT_ID.to_string()))
}

/// Separado de `client_id()` para poder probarlo sin tocar el entorno.
fn validar(id: &str) -> Result<String, String> {
    if id.trim().is_empty() || id == SIN_CONFIGURAR {
        return Err(
            "Falta el Client ID de GitHub. Regístrala en Settings → Developer settings → \
             OAuth Apps (marcando «Enable Device Flow») y ponlo en `github.rs`."
                .to_string(),
        );
    }
    Ok(id.to_string())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // GitHub rechaza las peticiones sin User-Agent.
        .user_agent("nivora")
        .build()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- token

/// Guarda el token en el llavero del sistema.
///
/// Si no hay llavero disponible (equipos sin Secret Service, sesiones remotas)
/// se recurre a un fichero en el directorio de datos de la app — **nunca** en
/// `Workspace/`, que es lo que se sincroniza. Es peor, pero la alternativa sería
/// que la app no funcionase en esos equipos.
pub fn guardar_token(token: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICIO_LLAVERO, CUENTA_LLAVERO) {
        Ok(e) if e.set_password(token).is_ok() => Ok(()),
        _ => {
            log::warn!("sin llavero del sistema: el token queda en un fichero local");
            let ruta = ruta_respaldo()?;
            std::fs::write(&ruta, token).map_err(|e| e.to_string())?;
            permisos_privados(&ruta);
            Ok(())
        }
    }
}

pub fn leer_token() -> Option<String> {
    if let Ok(e) = keyring::Entry::new(SERVICIO_LLAVERO, CUENTA_LLAVERO) {
        if let Ok(t) = e.get_password() {
            return Some(t);
        }
    }
    ruta_respaldo()
        .ok()
        .and_then(|r| std::fs::read_to_string(r).ok())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

pub fn borrar_token() -> Result<(), String> {
    if let Ok(e) = keyring::Entry::new(SERVICIO_LLAVERO, CUENTA_LLAVERO) {
        let _ = e.delete_credential();
    }
    if let Ok(r) = ruta_respaldo() {
        let _ = std::fs::remove_file(r);
    }
    Ok(())
}

fn ruta_respaldo() -> Result<std::path::PathBuf, String> {
    let base = dirs_datos()?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base.join("github.token"))
}

/// Directorio de datos de la app, hermano de `Workspace/` pero fuera de él.
fn dirs_datos() -> Result<std::path::PathBuf, String> {
    std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share"))
        })
        .or_else(|| std::env::var_os("APPDATA").map(std::path::PathBuf::from))
        .map(|d| d.join("pe.pluton.nivora"))
        .ok_or_else(|| "no se pudo resolver el directorio de datos".to_string())
}

#[cfg(unix)]
fn permisos_privados(ruta: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(ruta, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn permisos_privados(_ruta: &std::path::Path) {}

// ---------------------------------------------------------------- device flow

/// Lo que se le enseña al usuario mientras espera su aprobación.
// `camelCase` porque esto cruza a TypeScript; en Rust se leen en snake_case.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodigoDispositivo {
    /// El código corto que teclea en GitHub, tipo `WDJB-MJHT`.
    pub codigo_usuario: String,
    /// Dónde teclearlo (`https://github.com/login/device`).
    pub url: String,
    /// Segundos hasta que caduca.
    pub caduca_en: u64,
}

#[derive(Deserialize)]
struct RespuestaCodigo {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct RespuestaToken {
    access_token: Option<String>,
    error: Option<String>,
}

/// Estado de la sesión. Vive en Rust (no en el webview) para que el
/// `device_code` no ande dando vueltas por JavaScript.
#[derive(Default)]
pub struct Sesion {
    /// Inicio de sesión a medias: (device_code, segundos entre consultas).
    en_curso: Mutex<Option<(String, u64)>>,
    /// Último usuario conocido, para firmar los commits con su nombre sin
    /// pedírselo a GitHub en cada sincronización.
    usuario: Mutex<Option<UsuarioGitHub>>,
}

impl Sesion {
    fn fijar(&self, codigo: String, intervalo: u64) {
        *self.en_curso.lock().unwrap() = Some((codigo, intervalo));
    }
    fn tomar(&self) -> Option<(String, u64)> {
        self.en_curso.lock().unwrap().clone()
    }
    fn limpiar(&self) {
        *self.en_curso.lock().unwrap() = None;
    }
    pub fn recordar(&self, u: &UsuarioGitHub) {
        *self.usuario.lock().unwrap() = Some(u.clone());
    }
    pub fn olvidar(&self) {
        *self.usuario.lock().unwrap() = None;
    }
    /// Cuenta con la sesión iniciada, si ya se conoce.
    pub fn login(&self) -> Option<String> {
        self.usuario.lock().unwrap().as_ref().map(|u| u.login.clone())
    }
    /// Autor de los commits. Si aún no sabemos quién es, se firma de forma
    /// genérica: el commit es cosmético, GitHub atribuye el push al dueño del
    /// token de todas formas.
    pub fn autor(&self) -> (String, String) {
        match self.usuario.lock().unwrap().as_ref() {
            Some(u) => (
                u.nombre.clone().unwrap_or_else(|| u.login.clone()),
                format!("{}@users.noreply.github.com", u.login),
            ),
            None => ("Nivora".into(), "notas@nivora".into()),
        }
    }
}

/// Paso 1: pedirle a GitHub el código que verá el usuario.
pub async fn pedir_codigo(sesion: &Sesion) -> Result<CodigoDispositivo, String> {
    let r: RespuestaCodigo = http()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id()?.as_str()), ("scope", AMBITO)])
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar con GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("respuesta inesperada de GitHub: {e}"))?;

    sesion.fijar(r.device_code, r.interval.max(1));
    Ok(CodigoDispositivo {
        codigo_usuario: r.user_code,
        url: r.verification_uri,
        caduca_en: r.expires_in,
    })
}

/// Paso 2: preguntar a GitHub hasta que el usuario apruebe (o caduque).
///
/// Hay que respetar el `interval` que manda GitHub y el `slow_down`: preguntar
/// más rápido de lo permitido hace que corten.
pub async fn esperar_aprobacion(sesion: &Sesion) -> Result<UsuarioGitHub, String> {
    let (device_code, mut intervalo) = sesion
        .tomar()
        .ok_or_else(|| "no hay ningún inicio de sesión en curso".to_string())?;
    let id = client_id()?;
    let cliente = http()?;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(intervalo)).await;

        let r: RespuestaToken = cliente
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", id.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| format!("no se pudo contactar con GitHub: {e}"))?
            .json()
            .await
            .map_err(|e| format!("respuesta inesperada de GitHub: {e}"))?;

        if let Some(token) = r.access_token {
            sesion.limpiar();
            guardar_token(&token)?;
            return usuario(&token).await;
        }

        match r.error.as_deref() {
            // El usuario todavía no ha aprobado: seguimos esperando.
            Some("authorization_pending") => continue,
            Some("slow_down") => intervalo += 5,
            Some("expired_token") => {
                sesion.limpiar();
                return Err("el código ha caducado, vuelve a intentarlo".into());
            }
            Some("access_denied") => {
                sesion.limpiar();
                return Err("has cancelado el acceso desde GitHub".into());
            }
            Some(otro) => {
                sesion.limpiar();
                return Err(format!("GitHub devolvió un error: {otro}"));
            }
            None => continue,
        }
    }
}

// ---------------------------------------------------------------- API

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsuarioGitHub {
    pub login: String,
    pub nombre: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Deserialize)]
struct RespuestaUsuario {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

/// Quién es el dueño del token. Sirve además para validar que sigue vivo (el
/// usuario puede haber revocado el acceso desde GitHub).
pub async fn usuario(token: &str) -> Result<UsuarioGitHub, String> {
    let resp = http()?
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar con GitHub: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("la sesión de GitHub ya no es válida".into());
    }
    let u: RespuestaUsuario = resp.json().await.map_err(|e| e.to_string())?;
    Ok(UsuarioGitHub { login: u.login, nombre: u.name, avatar: u.avatar_url })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoGitHub {
    pub nombre: String,
    /// `usuario/repositorio`.
    pub completo: String,
    /// URL HTTPS para clonar/empujar.
    pub url: String,
    pub privado: bool,
    /// Cuenta dueña del repositorio (`ana`, o el nombre de la organización).
    pub propietario: String,
    /// ¿Le da GitHub permiso de empuje a este usuario?
    pub escritura: bool,
}

/// ¿Es este repositorio de la cuenta con la sesión iniciada?
///
/// Es la pregunta que decide el reparto de poderes en una bóveda compartida:
/// - **el dueño** edita todo, pone y quita los candados, y su app **restaura**
///   las notas bloqueadas que otro haya cambiado por fuera;
/// - **un colaborador** crea, edita y borra lo que no esté bloqueado.
///
/// No sirve mirar el permiso de GitHub: en un repositorio privado personal *todo*
/// colaborador puede empujar, así que por ahí no se distingue a nadie.
pub fn es_mio(repo: &RepoGitHub, mi_login: &str) -> bool {
    repo.propietario.eq_ignore_ascii_case(mi_login)
}

#[derive(Deserialize)]
struct RespuestaRepo {
    name: String,
    full_name: String,
    clone_url: String,
    private: bool,
    #[serde(default)]
    permissions: Option<Permisos>,
    #[serde(default)]
    owner: Option<Duenio>,
}

#[derive(Deserialize)]
struct Duenio {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct Permisos {
    #[serde(default)]
    push: bool,
}

impl From<RespuestaRepo> for RepoGitHub {
    fn from(r: RespuestaRepo) -> Self {
        Self {
            nombre: r.name,
            completo: r.full_name,
            url: r.clone_url,
            privado: r.private,
            propietario: r.owner.map(|o| o.login).unwrap_or_default(),
            // Sin el bloque `permissions` (respuestas recortadas) se asume que
            // NO hay escritura: es el lado seguro — como mucho la bóveda se abre
            // de solo lectura y el usuario lo ve, en vez de intentar subir y
            // fallar en cada guardado.
            escritura: r.permissions.map(|p| p.push).unwrap_or(false),
        }
    }
}

/// Por qué falló `repo_por_url`. Distinguirlo importa: «no lo veo» significa que
/// te han quitado el acceso, pero «no llego a GitHub» solo significa que hoy no
/// hay red — y confundirlos llevaría a marcar bóvedas como perdidas por un wifi
/// malo.
#[derive(Debug, Clone, PartialEq)]
pub enum FalloRepo {
    /// GitHub contestó que ese repositorio no existe para ti (404). En un repo
    /// privado es exactamente lo que se ve cuando te sacan de la lista de
    /// colaboradores.
    NoVisible,
    /// No se pudo preguntar (sin red, GitHub caído, token inválido).
    NoSeSabe,
}

/// Consulta un repositorio por su URL de clonado. Además de los permisos, sirve
/// para saber si el usuario **sigue teniendo acceso**.
pub async fn repo_por_url(token: &str, url: &str) -> Result<RepoGitHub, String> {
    consultar_repo(token, url).await.map_err(|(e, _)| e)
}

/// Igual, pero diciendo **por qué** falló.
pub async fn consultar_repo(
    token: &str,
    url: &str,
) -> Result<RepoGitHub, (String, FalloRepo)> {
    // `https://github.com/ana/notas.git` → `ana/notas`
    let completo = url
        .trim_end_matches(".git")
        .rsplit('/')
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("/");

    let cliente = http().map_err(|e| (e, FalloRepo::NoSeSabe))?;
    let resp = cliente
        .get(format!("https://api.github.com/repos/{completo}"))
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| (format!("no se pudo contactar con GitHub: {e}"), FalloRepo::NoSeSabe))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err((
            "ya no tienes acceso a este repositorio".into(),
            FalloRepo::NoVisible,
        ));
    }
    if !resp.status().is_success() {
        return Err((
            format!("GitHub no devolvió el repositorio ({})", resp.status()),
            FalloRepo::NoSeSabe,
        ));
    }
    let r: RespuestaRepo = resp
        .json()
        .await
        .map_err(|e| (e.to_string(), FalloRepo::NoSeSabe))?;
    Ok(r.into())
}

/// Cuerpo de la petición de creación. Separado para poder comprobar en un test
/// que `private` es `true` sin tocar la red.
fn cuerpo_repo(nombre: &str) -> serde_json::Value {
    serde_json::json!({
        "name": nombre,
        // SIEMPRE privado, y no es configurable. Son las notas de alguien: un
        // clic distraído en una casilla las publicaría en internet abierto, y eso
        // no se deshace (GitHub cachea, los buscadores indexan, cualquiera pudo
        // haber hecho un fork). Los repos privados son gratis e ilimitados, así
        // que la opción solo aportaba riesgo.
        "private": true,
        // `auto_init: false` a propósito — si GitHub creara un commit inicial con
        // su README, el repositorio tendría una historia que el equipo del
        // usuario no conoce y el primer push sería rechazado.
        "auto_init": false,
        "description": "Notas de Nivora",
    })
}

/// Crea el repositorio, siempre privado (ver `cuerpo_repo`).
pub async fn crear_repo(token: &str, nombre: &str) -> Result<RepoGitHub, String> {
    let resp = http()?
        .post("https://api.github.com/user/repos")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .json(&cuerpo_repo(nombre))
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar con GitHub: {e}"))?;

    let estado = resp.status();
    if estado == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Err(format!("ya tienes un repositorio llamado «{nombre}»"));
    }
    if !estado.is_success() {
        return Err(format!("GitHub rechazó la creación ({estado})"));
    }
    let r: RespuestaRepo = resp.json().await.map_err(|e| e.to_string())?;
    Ok(r.into())
}

/// Repositorios a los que el usuario tiene acceso, los más recientes primero. Es
/// la lista que ve en el segundo equipo para elegir cuál conectar.
///
/// Incluye a propósito los que **no son suyos** (`collaborator`,
/// `organization_member`): así, si alguien le comparte su cuaderno añadiéndole
/// como colaborador en GitHub, le aparece aquí. Con `affiliation=owner` a secas
/// un cuaderno compartido no salía en la lista y no había forma de conectarlo.
/// El nombre se muestra completo (`quien/repositorio`) para distinguirlos.
pub async fn listar_repos(token: &str) -> Result<Vec<RepoGitHub>, String> {
    let repos: Vec<RespuestaRepo> = http()?
        .get(
            "https://api.github.com/user/repos\
             ?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
        )
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("no se pudo contactar con GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(repos.into_iter().map(Into::into).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_client_id_el_error_explica_que_hacer() {
        // Sin configurar, el fallo tiene que decir dónde se arregla y no un
        // "unauthorized" a secas desde GitHub.
        for vacio in [SIN_CONFIGURAR, "", "   "] {
            let e = validar(vacio).unwrap_err();
            assert!(e.contains("Developer settings"), "{e}");
            assert!(e.contains("Device Flow"), "{e}");
        }
    }

    #[test]
    fn la_app_trae_su_client_id_configurado() {
        // Si alguien lo borra al refactorizar, el inicio de sesión deja de
        // funcionar para TODOS los usuarios y solo se notaría al pulsar el botón.
        assert!(validar(CLIENT_ID).is_ok(), "el Client ID no puede quedarse sin poner");
        assert!(CLIENT_ID.starts_with("Ov23li"), "no parece un Client ID de GitHub");
    }

    #[test]
    fn el_token_de_respaldo_jamas_cae_dentro_del_workspace() {
        // Si el fichero de respaldo acabara en Workspace/, se subiría al repo en
        // el primer commit. Es el peor fallo posible de esta pantalla.
        let ruta = ruta_respaldo().unwrap();
        assert!(
            !ruta.components().any(|c| c.as_os_str() == "Workspace"),
            "el token no puede vivir en el workspace: {}",
            ruta.display()
        );
    }

    #[test]
    fn sin_bloque_de_permisos_se_asume_solo_lectura() {
        // Es el lado seguro: la bóveda se abre de solo lectura y se ve, en vez
        // de intentar subir y fallar en cada guardado.
        let r: RespuestaRepo = serde_json::from_str(
            r#"{"name":"n","full_name":"a/n","clone_url":"https://x/a/n.git","private":true}"#,
        )
        .unwrap();
        assert!(!RepoGitHub::from(r).escritura);
    }

    #[test]
    fn el_propietario_sale_del_bloque_owner() {
        let r: RespuestaRepo = serde_json::from_str(
            r#"{"name":"n","full_name":"ana/n","clone_url":"https://x/ana/n.git",
                 "private":true,"owner":{"login":"ana"}}"#,
        )
        .unwrap();
        assert_eq!(RepoGitHub::from(r).propietario, "ana");
    }

    #[test]
    fn el_permiso_de_escritura_sale_de_permissions_push() {
        let con = |push: bool| {
            let j = format!(
                r#"{{"name":"n","full_name":"a/n","clone_url":"https://x/a/n.git",
                     "private":true,"permissions":{{"push":{push},"pull":true}}}}"#
            );
            RepoGitHub::from(serde_json::from_str::<RespuestaRepo>(&j).unwrap()).escritura
        };
        assert!(con(true));
        // Colaborador con rol Read en un repo de organización.
        assert!(!con(false));
    }

    #[test]
    fn el_repositorio_se_crea_siempre_privado() {
        // Publicar las notas de alguien no se deshace: GitHub cachea, los
        // buscadores indexan y pueden haberlo copiado. Si un refactor pusiera
        // esto en `false`, no se notaría hasta que fuera tarde.
        assert_eq!(cuerpo_repo("mis-notas")["private"], serde_json::json!(true));
        assert_eq!(cuerpo_repo("mis-notas")["name"], serde_json::json!("mis-notas"));
    }

    fn repo(propietario: &str, escritura: bool) -> RepoGitHub {
        RepoGitHub {
            nombre: "notas".into(),
            completo: format!("{propietario}/notas"),
            url: format!("https://github.com/{propietario}/notas.git"),
            privado: true,
            propietario: propietario.into(),
            escritura,
        }
    }

    #[test]
    fn el_dueno_se_reconoce_por_la_cuenta_del_repositorio() {
        assert!(es_mio(&repo("ana", true), "ana"));
        // GitHub no distingue mayúsculas en los nombres de cuenta.
        assert!(es_mio(&repo("Ana", true), "ana"));
    }

    #[test]
    fn quien_recibe_un_cuaderno_no_es_su_dueno_aunque_pueda_empujar() {
        // El caso que motiva la regla: en un repositorio PRIVADO personal, todo
        // colaborador puede empujar. Mirando el permiso de GitHub no habría forma
        // de distinguir al dueño, y cualquiera podría quitar los candados.
        assert!(!es_mio(&repo("ana", true), "luis"));
    }

    #[test]
    fn solo_se_pide_el_permiso_imprescindible() {
        assert_eq!(AMBITO, "repo");
    }
}
