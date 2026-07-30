//! Bóvedas: varios workspaces independientes entre los que se puede cambiar.
//!
//! Cada bóveda es una carpeta completa y autónoma — notas, imágenes, índice y
//! **su propio repositorio git**:
//!
//! ```text
//! <boveda>/
//! ├─ notas/<id>.json
//! ├─ assets/<hash>.<ext>
//! ├─ workspace.db      (índice derivado, no se sincroniza)
//! └─ .git/             (SU remoto, no el de las demás)
//! ```
//!
//! Ese "su propio repositorio" es lo que permite compartir: la bóveda personal
//! apunta al repositorio privado del usuario y una bóveda compartida al de otra
//! persona, donde figura como colaborador. Sin bóvedas, compartir sería todo o
//! nada; con ellas, cada una tiene su alcance.
//!
//! El **registro** (`bovedas.json`) vive en el directorio de datos de la app,
//! nunca dentro de una bóveda: es de este equipo y no debe viajar por git.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::almacen::{self, Almacen};
use crate::db::Db;

/// Nombre de la bóveda que ya existía antes de que hubiera varias.
const NOMBRE_INICIAL: &str = "Mis notas";

/// Carpeta (dentro de los datos de la app) donde se crean las bóvedas nuevas.
/// La original se queda donde estaba: mover las notas de sitio solo para que el
/// árbol quede simétrico sería arriesgar los datos del usuario a cambio de nada.
const DIR_BOVEDAS: &str = "Bovedas";

// `camelCase` porque esto cruza a TypeScript (y así queda también en el JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Boveda {
    pub id: String,
    pub nombre: String,
    /// Ruta absoluta. Absoluta y no relativa porque el registro es de este
    /// equipo y así una bóveda puede vivir donde quiera el usuario.
    pub ruta: String,
    /// La bóveda **entera** se ve pero no se toca.
    ///
    /// Lo decide el permiso real de GitHub (`permissions.push`), así que en la
    /// práctica solo pasa con un repositorio de **organización** donde tienes rol
    /// *Read*: en uno privado personal GitHub le da escritura a todo
    /// colaborador. Es a propósito — compartir una bóveda es montar un cuaderno
    /// de equipo, y lo que protege hojas concretas es el candado por nota
    /// (`Documento::bloqueada`), no cerrar el cuaderno entero.
    ///
    /// Quién es el dueño es otra pregunta distinta; va en `soy_dueno`.
    ///
    /// El veto lo aplica Rust en cada comando de escritura, no solo la interfaz.
    #[serde(default)]
    pub solo_lectura: bool,
    /// El repositorio de esta bóveda es de esta cuenta.
    ///
    /// El dueño manda: es el único que puede poner y quitar el candado de una
    /// nota, y el único cuya app **restaura** las notas bloqueadas que otro haya
    /// cambiado. Una bóveda local sin remoto es tuya, así que por defecto `true`.
    #[serde(default = "verdadero")]
    pub soy_dueno: bool,
    /// El repositorio ya no está a tu alcance: te han quitado el acceso, o lo
    /// han borrado o renombrado.
    ///
    /// La bóveda **no se borra** — puede tener notas que escribiste tú, y
    /// borrarle ficheros a alguien porque un tercero pulsó algo en GitHub sería
    /// una puerta trasera. Lo que se hace es dejar de sincronizar, decirlo, y
    /// ofrecer quitarla; la decisión es del usuario.
    #[serde(default)]
    pub sin_acceso: bool,
}

fn verdadero() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Registro {
    activa: Option<String>,
    #[serde(default)]
    bovedas: Vec<Boveda>,
}

/// La bóveda abierta ahora mismo, con su índice y su almacén ya montados.
struct Abierta {
    boveda: Boveda,
    db: Arc<Db>,
    almacen: Arc<Almacen>,
}

/// Estado global de la app: el registro de bóvedas y cuál está abierta.
///
/// `Db` y `Almacen` van detrás de un `Mutex` (y no como estados de Tauri
/// independientes) justamente para poder **sustituirlos** al cambiar de bóveda.
pub struct Bovedas {
    base: PathBuf,
    estado: Mutex<(Registro, Abierta)>,
}

/// Deja lista una carpeta como bóveda y devuelve su índice y su almacén.
///
/// Es la secuencia de arranque de siempre, y el **orden importa**: migrar antes
/// de reconstruir, porque la reconstrucción vacía las tablas y se llevaría por
/// delante las notas de un workspace anterior antes de volcarlas a fichero.
fn abrir(ruta: &Path) -> Result<(Arc<Db>, Arc<Almacen>), String> {
    for sub in ["notas", "assets", "backups", "export"] {
        std::fs::create_dir_all(ruta.join(sub)).map_err(|e| e.to_string())?;
    }
    if let Err(e) = almacen::escribir_gitignore(ruta) {
        log::warn!("no se pudo escribir .gitignore: {e}");
    }

    let db = Db::abrir(&ruta.join("workspace.db"))?;
    let alm = Almacen::nuevo(&ruta.join("notas"))?;

    alm.migrar_desde_db(&db)?;
    let n = alm.reconstruir(&db)?;
    if let Err(e) = db.reconstruir_assets(&ruta.join("assets")) {
        log::warn!("no se pudo reindexar assets/: {e}");
    }
    log::info!("bóveda lista en {} ({n} notas)", ruta.display());

    Ok((Arc::new(db), Arc::new(alm)))
}

/// Convierte un nombre en algo usable como carpeta.
fn carpeta_para(nombre: &str) -> String {
    let limpio: String = nombre
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let limpio = limpio.trim_matches('-').replace("--", "-");
    if limpio.is_empty() { "boveda".to_string() } else { limpio }
}

impl Bovedas {
    /// Carga el registro (creándolo la primera vez) y abre la bóveda activa.
    pub fn iniciar(base: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
        let ruta_registro = base.join("bovedas.json");

        let mut registro: Registro = std::fs::read_to_string(&ruta_registro)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();

        // Primera vez con bóvedas: se registra el `Workspace/` que ya existía,
        // SIN moverlo. Las notas del usuario se quedan exactamente donde están.
        if registro.bovedas.is_empty() {
            let ruta = base.join("Workspace");
            registro.bovedas.push(Boveda {
                id: Uuid::new_v4().to_string(),
                nombre: NOMBRE_INICIAL.to_string(),
                ruta: ruta.to_string_lossy().into_owned(),
                solo_lectura: false,
                soy_dueno: true,
                sin_acceso: false,
            });
            registro.activa = registro.bovedas.first().map(|b| b.id.clone());
        }

        // Si la activa apunta a algo que ya no está en la lista, se cae a la
        // primera en vez de dejar la app sin bóveda.
        let activa = registro
            .activa
            .clone()
            .filter(|id| registro.bovedas.iter().any(|b| &b.id == id))
            .or_else(|| registro.bovedas.first().map(|b| b.id.clone()))
            .ok_or("no hay ninguna bóveda")?;
        registro.activa = Some(activa.clone());

        let boveda = registro
            .bovedas
            .iter()
            .find(|b| b.id == activa)
            .cloned()
            .ok_or("no hay ninguna bóveda")?;
        let (db, almacen) = abrir(Path::new(&boveda.ruta))?;

        let bovedas = Self {
            base: base.to_path_buf(),
            estado: Mutex::new((registro, Abierta { boveda, db, almacen })),
        };
        bovedas.guardar_registro()?;
        Ok(bovedas)
    }

    fn guardar_registro(&self) -> Result<(), String> {
        let estado = self.estado.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&estado.0).map_err(|e| e.to_string())?;
        std::fs::write(self.base.join("bovedas.json"), json).map_err(|e| e.to_string())
    }

    /// Índice de la bóveda activa. Devuelve un `Arc` clonado y suelta el
    /// candado en el acto: los comandos de sincronización son `async` y no
    /// pueden quedarse con un `MutexGuard` cruzando un `await`.
    pub fn db(&self) -> Arc<Db> {
        self.estado.lock().unwrap().1.db.clone()
    }

    pub fn almacen(&self) -> Arc<Almacen> {
        self.estado.lock().unwrap().1.almacen.clone()
    }

    /// Carpeta de la bóveda activa. Todo lo que escriba en disco (notas,
    /// imágenes, git) tiene que colgar de aquí, nunca de una ruta fija.
    pub fn ruta(&self) -> PathBuf {
        PathBuf::from(&self.estado.lock().unwrap().1.boveda.ruta)
    }

    pub fn activa(&self) -> Boveda {
        self.estado.lock().unwrap().1.boveda.clone()
    }

    pub fn listar(&self) -> Vec<Boveda> {
        self.estado.lock().unwrap().0.bovedas.clone()
    }

    /// Crea una bóveda vacía y **cambia a ella**. Es también el primer paso para
    /// conectar una compartida: se crea vacía y luego `conectar_repo` la llena.
    pub fn crear(&self, nombre: &str) -> Result<Boveda, String> {
        let nombre = nombre.trim();
        if nombre.is_empty() {
            return Err("la bóveda necesita un nombre".into());
        }

        // Carpeta libre: si ya existe `equipo`, se prueba `equipo-2`, etc.
        let raiz = self.base.join(DIR_BOVEDAS);
        let tallo = carpeta_para(nombre);
        let mut ruta = raiz.join(&tallo);
        let mut n = 2;
        while ruta.exists() {
            ruta = raiz.join(format!("{tallo}-{n}"));
            n += 1;
        }
        std::fs::create_dir_all(&ruta).map_err(|e| e.to_string())?;

        let boveda = Boveda {
            id: Uuid::new_v4().to_string(),
            nombre: nombre.to_string(),
            ruta: ruta.to_string_lossy().into_owned(),
            solo_lectura: false,
            soy_dueno: true,
            sin_acceso: false,
        };
        {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            estado.0.bovedas.push(boveda.clone());
        }
        self.guardar_registro()?;
        self.cambiar(&boveda.id)
    }

    /// Abre otra bóveda. A partir de aquí todos los comandos trabajan sobre ella.
    ///
    /// Quien llame a esto desde la UI tiene que haber **vaciado antes el
    /// guardado pendiente**: el autoguardado va con temporizador y si salta
    /// después del cambio, la nota se escribiría en la bóveda equivocada.
    pub fn cambiar(&self, id: &str) -> Result<Boveda, String> {
        let boveda = self
            .estado
            .lock()
            .map_err(|e| e.to_string())?
            .0
            .bovedas
            .iter()
            .find(|b| b.id == id)
            .cloned()
            .ok_or_else(|| format!("no existe la bóveda {id}"))?;

        // Se abre ANTES de tocar el estado: si la carpeta ha desaparecido o el
        // índice no se puede crear, la app se queda con la bóveda actual en vez
        // de quedarse sin ninguna.
        let (db, almacen) = abrir(Path::new(&boveda.ruta))?;

        {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            estado.0.activa = Some(boveda.id.clone());
            estado.1 = Abierta { boveda: boveda.clone(), db, almacen };
        }
        self.guardar_registro()?;
        Ok(boveda)
    }

    /// Quita una bóveda del registro. **No borra los ficheros**: una bóveda
    /// compartida sigue viva en el repositorio de otra persona, y una propia
    /// puede volver a añadirse. Borrar notas es una acción aparte y explícita.
    pub fn olvidar(&self, id: &str) -> Result<(), String> {
        let cambiar_a = {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            if estado.0.bovedas.len() <= 1 {
                return Err("no puedes quitar la única bóveda que tienes".into());
            }
            estado.0.bovedas.retain(|b| b.id != id);
            // Si se quitó la que estaba abierta, hay que abrir otra.
            (estado.1.boveda.id == id).then(|| estado.0.bovedas[0].id.clone())
        };
        self.guardar_registro()?;
        if let Some(otra) = cambiar_a {
            self.cambiar(&otra)?;
        }
        Ok(())
    }

    /// Marca (o desmarca) la bóveda como de solo lectura. Lo llama la
    /// sincronización con lo que diga GitHub: al conectar, y también si un push
    /// se rechaza por permisos porque el dueño se los ha quitado después.
    pub fn marcar_solo_lectura(&self, id: &str, valor: bool) -> Result<(), String> {
        {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            let Some(b) = estado.0.bovedas.iter_mut().find(|b| b.id == id) else {
                return Ok(());
            };
            if b.solo_lectura == valor {
                return Ok(());
            }
            b.solo_lectura = valor;
            let copia = b.clone();
            if estado.1.boveda.id == id {
                estado.1.boveda = copia;
            }
        }
        self.guardar_registro()
    }

    /// Marca (o levanta) la pérdida de acceso al repositorio.
    pub fn marcar_sin_acceso(&self, id: &str, valor: bool) -> Result<(), String> {
        {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            let Some(b) = estado.0.bovedas.iter_mut().find(|b| b.id == id) else {
                return Ok(());
            };
            if b.sin_acceso == valor {
                return Ok(());
            }
            b.sin_acceso = valor;
            let copia = b.clone();
            if estado.1.boveda.id == id {
                estado.1.boveda = copia;
            }
        }
        self.guardar_registro()
    }

    /// Registra si el repositorio de la bóveda es de esta cuenta.
    pub fn marcar_dueno(&self, id: &str, valor: bool) -> Result<(), String> {
        {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            let Some(b) = estado.0.bovedas.iter_mut().find(|b| b.id == id) else {
                return Ok(());
            };
            if b.soy_dueno == valor {
                return Ok(());
            }
            b.soy_dueno = valor;
            let copia = b.clone();
            if estado.1.boveda.id == id {
                estado.1.boveda = copia;
            }
        }
        self.guardar_registro()
    }

    /// Cambia el nombre visible. No mueve la carpeta: la ruta ya está en el
    /// registro y renombrarla solo daría ocasión de perder notas.
    pub fn renombrar(&self, id: &str, nombre: &str) -> Result<Boveda, String> {
        let nombre = nombre.trim();
        if nombre.is_empty() {
            return Err("la bóveda necesita un nombre".into());
        }
        let boveda = {
            let mut estado = self.estado.lock().map_err(|e| e.to_string())?;
            let b = estado
                .0
                .bovedas
                .iter_mut()
                .find(|b| b.id == id)
                .ok_or_else(|| format!("no existe la bóveda {id}"))?;
            b.nombre = nombre.to_string();
            let copia = b.clone();
            if estado.1.boveda.id == id {
                estado.1.boveda = copia.clone();
            }
            copia
        };
        self.guardar_registro()?;
        Ok(boveda)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Documento;

    struct Temporal(PathBuf);

    impl Temporal {
        fn nueva() -> Self {
            let d = std::env::temp_dir().join(format!("bovedas-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
    }

    impl Drop for Temporal {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn nota(titulo: &str) -> Documento {
        Documento {
            id: None,
            titulo: titulo.into(),
            icono: None,
            cover: None,
            tags: vec![],
            bloqueada: false,
            contenido: serde_json::json!({ "type": "doc", "content": [] }),
            creado: None,
            modificado: None,
        }
    }

    fn titulos(b: &Bovedas) -> Vec<String> {
        let mut v: Vec<String> = b.db().listar().unwrap().into_iter().map(|d| d.titulo).collect();
        v.sort();
        v
    }

    #[test]
    fn la_primera_vez_adopta_el_workspace_existente_sin_moverlo() {
        let t = Temporal::nueva();
        // Un workspace anterior a las bóvedas, con una nota ya escrita.
        let ws = t.0.join("Workspace");
        std::fs::create_dir_all(ws.join("notas")).unwrap();
        {
            let db = Db::abrir(&ws.join("workspace.db")).unwrap();
            let al = Almacen::nuevo(&ws.join("notas")).unwrap();
            al.guardar(&db, nota("La de siempre")).unwrap();
        }

        let b = Bovedas::iniciar(&t.0).unwrap();

        assert_eq!(b.listar().len(), 1);
        assert_eq!(b.activa().nombre, NOMBRE_INICIAL);
        // Lo importante: la carpeta NO se ha movido y la nota sigue ahí.
        assert_eq!(b.ruta(), ws);
        assert!(ws.join("notas").exists());
        assert_eq!(titulos(&b), vec!["La de siempre".to_string()]);
    }

    #[test]
    fn cada_boveda_tiene_sus_propias_notas() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let personal = b.activa().id;

        b.almacen().guardar(&b.db(), nota("Privada")).unwrap();

        let equipo = b.crear("Notas del equipo").unwrap();
        // `crear` cambia a la nueva: debe estar vacía.
        assert_eq!(b.activa().id, equipo.id);
        assert!(titulos(&b).is_empty(), "una bóveda nueva empieza vacía");

        b.almacen().guardar(&b.db(), nota("Compartida")).unwrap();
        assert_eq!(titulos(&b), vec!["Compartida".to_string()]);

        // Y al volver, la personal sigue como estaba: sin rastro de la otra.
        b.cambiar(&personal).unwrap();
        assert_eq!(titulos(&b), vec!["Privada".to_string()]);
    }

    #[test]
    fn cada_boveda_escribe_en_su_propia_carpeta() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        b.almacen().guardar(&b.db(), nota("Privada")).unwrap();
        let ruta_personal = b.ruta();

        b.crear("Equipo").unwrap();
        let ruta_equipo = b.ruta();
        b.almacen().guardar(&b.db(), nota("Compartida")).unwrap();

        assert_ne!(ruta_personal, ruta_equipo);
        let cuenta = |d: PathBuf| std::fs::read_dir(d.join("notas")).unwrap().count();
        assert_eq!(cuenta(ruta_personal), 1);
        assert_eq!(cuenta(ruta_equipo), 1);
    }

    #[test]
    fn la_boveda_activa_sobrevive_al_reinicio() {
        let t = Temporal::nueva();
        let equipo = {
            let b = Bovedas::iniciar(&t.0).unwrap();
            let e = b.crear("Equipo").unwrap();
            b.almacen().guardar(&b.db(), nota("Compartida")).unwrap();
            e
        };

        // Segunda ejecución de la app: debe abrir donde el usuario lo dejó.
        let b = Bovedas::iniciar(&t.0).unwrap();
        assert_eq!(b.activa().id, equipo.id);
        assert_eq!(titulos(&b), vec!["Compartida".to_string()]);
    }

    #[test]
    fn dos_bovedas_con_el_mismo_nombre_no_comparten_carpeta() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let una = b.crear("Equipo").unwrap();
        let otra = b.crear("Equipo").unwrap();

        // Si compartieran carpeta, las notas de una aparecerían en la otra.
        assert_ne!(una.ruta, otra.ruta);
    }

    #[test]
    fn cambiar_a_una_boveda_rota_no_deja_la_app_sin_boveda() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        b.almacen().guardar(&b.db(), nota("Privada")).unwrap();
        let personal = b.activa().id;

        let fantasma = Boveda {
            id: "no-existe".into(),
            nombre: "Fantasma".into(),
            ruta: "/proc/imposible/boveda".into(),
            solo_lectura: false,
            soy_dueno: true,
            sin_acceso: false,
        };
        {
            let mut estado = b.estado.lock().unwrap();
            estado.0.bovedas.push(fantasma);
        }

        assert!(b.cambiar("no-existe").is_err());
        // Sigue abierta la de antes y las notas se leen igual.
        assert_eq!(b.activa().id, personal);
        assert_eq!(titulos(&b), vec!["Privada".to_string()]);
    }

    #[test]
    fn olvidar_no_borra_las_notas_del_disco() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let equipo = b.crear("Equipo").unwrap();
        b.almacen().guardar(&b.db(), nota("Compartida")).unwrap();
        let ruta = PathBuf::from(&equipo.ruta);

        b.olvidar(&equipo.id).unwrap();

        assert_eq!(b.listar().len(), 1);
        assert_ne!(b.activa().id, equipo.id, "debe abrirse otra bóveda");
        // Una bóveda compartida sigue viva en el repositorio de otra persona:
        // quitarla de la lista no puede borrar nada.
        assert_eq!(std::fs::read_dir(ruta.join("notas")).unwrap().count(), 1);
    }

    #[test]
    fn una_boveda_nace_editable_y_puede_pasar_a_solo_lectura() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let equipo = b.crear("Equipo").unwrap();
        assert!(!equipo.solo_lectura, "una bóveda propia nace editable");

        b.marcar_solo_lectura(&equipo.id, true).unwrap();
        assert!(b.activa().solo_lectura);

        // Y sobrevive al reinicio: si no, la app volvería a intentar subir en
        // cada guardado y el usuario vería un error tras otro.
        let b = Bovedas::iniciar(&t.0).unwrap();
        assert!(b.activa().solo_lectura);
    }

    #[test]
    fn el_modo_solo_lectura_es_de_cada_boveda_por_separado() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let personal = b.activa().id;
        let compartida = b.crear("Compartida").unwrap();
        b.marcar_solo_lectura(&compartida.id, true).unwrap();

        // Lo importante: que la bóveda compartida sea de solo lectura no puede
        // bloquear las notas propias del usuario.
        b.cambiar(&personal).unwrap();
        assert!(!b.activa().solo_lectura);
        b.cambiar(&compartida.id).unwrap();
        assert!(b.activa().solo_lectura);
    }

    #[test]
    fn no_se_puede_quedar_sin_ninguna_boveda() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        assert!(b.olvidar(&b.activa().id).is_err());
        assert_eq!(b.listar().len(), 1);
    }

    #[test]
    fn renombrar_no_mueve_la_carpeta() {
        let t = Temporal::nueva();
        let b = Bovedas::iniciar(&t.0).unwrap();
        let antes = b.ruta();
        b.almacen().guardar(&b.db(), nota("Privada")).unwrap();

        let r = b.renombrar(&b.activa().id, "Personal").unwrap();

        assert_eq!(r.nombre, "Personal");
        assert_eq!(b.activa().nombre, "Personal");
        assert_eq!(b.ruta(), antes, "la ruta no cambia al renombrar");
        assert_eq!(titulos(&b), vec!["Privada".to_string()]);
    }
}

#[cfg(test)]
mod tests_solo_lectura {
    use super::*;
    use crate::models::Documento;

    fn nota(titulo: &str) -> Documento {
        Documento {
            id: None,
            titulo: titulo.into(),
            icono: None,
            cover: None,
            tags: vec![],
            bloqueada: false,
            contenido: serde_json::json!({ "type": "doc", "content": [] }),
            creado: None,
            modificado: None,
        }
    }

    /// El veto vive en `commands::exigir_escritura`, pero lo que ese comando
    /// consulta es esto: si la bóveda activa está marcada, no se escribe. Aquí se
    /// comprueba que la marca llega intacta a quien tiene que decidir.
    #[test]
    fn la_boveda_activa_expone_su_modo_a_los_comandos() {
        let dir = std::env::temp_dir().join(format!("solo-lectura-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let b = Bovedas::iniciar(&dir).unwrap();

        let ajena = b.crear("Cuaderno de Ana").unwrap();
        b.marcar_solo_lectura(&ajena.id, true).unwrap();
        assert!(b.activa().solo_lectura, "un cuaderno ajeno no se toca");

        // Y la propia sigue editándose: escribir de verdad tiene que funcionar.
        let mia = b.listar().iter().find(|x| x.id != ajena.id).unwrap().id.clone();
        b.cambiar(&mia).unwrap();
        assert!(!b.activa().solo_lectura);
        assert!(b.almacen().guardar(&b.db(), nota("Mía")).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
