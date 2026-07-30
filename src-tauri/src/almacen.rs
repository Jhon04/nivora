//! Almacén de notas en ficheros.
//!
//! Cada documento es un `Workspace/notas/<id>.json` **formateado con
//! indentación**: el fichero es la fuente de verdad y `workspace.db` pasa a ser
//! un índice derivado (listados, etiquetas y búsqueda FTS5) que se reconstruye a
//! partir de los ficheros al arrancar.
//!
//! El motivo es sincronizar el workspace entre equipos. Con un fichero por nota,
//! git / Syncthing / un pendrive valen tal cual: un conflicto afecta a **una**
//! nota y no a la biblioteca entera, y borrar una nota es borrar un fichero (no
//! hace falta una tabla de lápidas para que el borrado viaje al otro equipo).
//!
//! Sincronizar `workspace.db` sería justo lo contrario: SQLite escribe en varios
//! pasos no atómicos, así que copiarlo a media escritura lo parte, y un conflicto
//! obliga a elegir un lado perdiendo todas las notas del otro. Por eso el
//! `.gitignore` que se escribe en el workspace lo excluye.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use uuid::Uuid;

use crate::db::Db;
use crate::models::Documento;

/// Normaliza una etiqueta: recorta, colapsa espacios y pasa a minúsculas (para
/// que "Trabajo" y "trabajo" sean la misma etiqueta).
pub fn normalizar_tag(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Etiquetas normalizadas, sin duplicados y ordenadas. Se ordenan porque el
/// fichero se versiona: si el orden dependiera de cómo las escribió el usuario,
/// cada guardado ensuciaría el diff sin haber cambiado nada.
fn normalizar_tags(tags: &[String]) -> Vec<String> {
    let mut v: Vec<String> = tags
        .iter()
        .map(|t| normalizar_tag(t))
        .filter(|t| !t.is_empty())
        .collect();
    v.sort();
    v.dedup();
    v
}

/// ¿El id sirve como nombre de fichero? Los generamos nosotros (UUID v4), pero
/// el id llega desde el webview en `guardar_documento`: sin esta comprobación un
/// id como `../../otra-cosa` escribiría fuera de `notas/`.
fn id_valido(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Ficheros que hay que ignorar al recorrer `notas/`: las copias en conflicto
/// que dejan los sincronizadores (`nota.sync-conflict-2026….json` de Syncthing,
/// `nota (copia en conflicto de …).json` de otros) tienen el **mismo id dentro**
/// que el original. Si se leyeran, una de las dos versiones pisaría a la otra en
/// el índice según el orden del directorio. Se dejan en disco para que el
/// usuario las vea, pero no entran en la biblioteca.
fn es_copia_en_conflicto(nombre: &str) -> bool {
    let n = nombre.to_lowercase();
    n.contains("sync-conflict") || n.contains("conflict") || n.contains("conflicto")
}

/// Nota bloqueada que alguien cambió y ha vuelto a su sitio. Lleva el título
/// porque un UUID no le dice nada al usuario.
// `camelCase` porque cruza a TypeScript.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotaRestaurada {
    pub id: String,
    pub titulo: String,
    /// Fichero donde quedó la versión ajena, por si el usuario quiere mirarla.
    pub copia: Option<String>,
}

/// Dueño de `Workspace/notas/`. Se registra como estado de Tauri igual que `Db`.
pub struct Almacen {
    dir: PathBuf,
}

impl Almacen {
    pub fn nuevo(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(Self { dir: dir.to_path_buf() })
    }

    fn ruta(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Escribe la nota. La escritura es **atómica** (temporal + `rename`): si se
    /// corta la luz o el sincronizador copia justo en ese instante, se ve la
    /// versión vieja o la nueva, nunca media nota.
    fn escribir(&self, doc: &Documento) -> Result<(), String> {
        let id = doc.id.as_deref().ok_or("documento sin id")?;
        if !id_valido(id) {
            return Err(format!("id no válido: {id}"));
        }
        // `to_string_pretty` indenta y `serde_json` ordena las claves de los
        // objetos: dos guardados del mismo contenido dan el mismo fichero, así
        // que el diff de git solo muestra lo que cambió de verdad.
        let json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
        // git no versiona directorios: si al sincronizar se borra la última nota,
        // `notas/` desaparece del otro equipo y sin esto el siguiente guardado
        // fallaría hasta reiniciar.
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!(".{id}.tmp"));
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.ruta(id)).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Guarda: asigna id y fechas si faltan, escribe el fichero y actualiza el
    /// índice. El fichero va **primero**; si el índice fallara se reconstruye
    /// solo en el siguiente arranque, mientras que al revés se perdería la nota.
    pub fn guardar(&self, db: &Db, mut doc: Documento) -> Result<Documento, String> {
        let ahora = Utc::now().to_rfc3339();
        if doc.id.is_none() {
            doc.id = Some(Uuid::new_v4().to_string());
        }
        if doc.creado.is_none() {
            doc.creado = Some(ahora.clone());
        }
        doc.modificado = Some(ahora);
        doc.tags = normalizar_tags(&doc.tags);

        self.escribir(&doc)?;
        db.indexar(&doc)?;
        Ok(doc)
    }

    /// Lee una nota del disco. Devuelve `None` si no existe.
    pub fn leer(&self, id: &str) -> Result<Option<Documento>, String> {
        if !id_valido(id) {
            return Ok(None);
        }
        let ruta = self.ruta(id);
        if !ruta.exists() {
            return Ok(None);
        }
        let txt = fs::read_to_string(&ruta).map_err(|e| e.to_string())?;
        serde_json::from_str(&txt)
            .map(Some)
            .map_err(|e| format!("{} ilegible: {e}", ruta.display()))
    }

    /// Borra la nota del disco y del índice. Que el fichero desaparezca **es** la
    /// lápida: el sincronizador propaga el borrado a los demás equipos.
    pub fn eliminar(&self, db: &Db, id: &str) -> Result<(), String> {
        if !id_valido(id) {
            return Err(format!("id no válido: {id}"));
        }
        let ruta = self.ruta(id);
        if ruta.exists() {
            fs::remove_file(&ruta).map_err(|e| e.to_string())?;
        }
        db.eliminar(id)
    }

    /// Todas las notas del disco. Una nota ilegible (JSON roto, medio escrita por
    /// un sincronizador) se registra y se salta: un fichero malo no puede dejarte
    /// sin biblioteca.
    pub fn listar_todos(&self) -> Result<Vec<Documento>, String> {
        let mut docs = Vec::new();
        let entradas = match fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(_) => return Ok(docs),
        };
        for entrada in entradas.flatten() {
            let nombre = entrada.file_name().to_string_lossy().into_owned();
            if !nombre.ends_with(".json") || nombre.starts_with('.') {
                continue;
            }
            if es_copia_en_conflicto(&nombre) {
                log::warn!("copia en conflicto ignorada: {nombre}");
                continue;
            }
            let txt = match fs::read_to_string(entrada.path()) {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("no se pudo leer {nombre}: {e}");
                    continue;
                }
            };
            match serde_json::from_str::<Documento>(&txt) {
                Ok(d) if d.id.is_some() => docs.push(d),
                Ok(_) => log::warn!("{nombre} no tiene id, se ignora"),
                Err(e) => log::warn!("{nombre} ilegible, se ignora: {e}"),
            }
        }
        Ok(docs)
    }

    /// Copia del contenido en disco de las notas **bloqueadas**, para poder
    /// restaurarlas si llegan modificadas de otro equipo.
    ///
    /// Se toma justo antes de traer cambios; ver `restaurar_bloqueadas`.
    pub fn instantanea_bloqueadas(&self) -> Result<HashMap<String, String>, String> {
        let mut mapa = HashMap::new();
        for doc in self.listar_todos()? {
            if !doc.bloqueada {
                continue;
            }
            let Some(id) = doc.id.clone() else { continue };
            if let Ok(txt) = fs::read_to_string(self.ruta(&id)) {
                mapa.insert(id, txt);
            }
        }
        Ok(mapa)
    }

    /// Devuelve a su sitio las notas bloqueadas que otro equipo haya cambiado o
    /// borrado. Devuelve los ids restaurados.
    ///
    /// Esto es lo que hace que el candado valga de algo. La marca vive dentro de
    /// un fichero de un repositorio donde el colaborador tiene escritura, así que
    /// **puede saltársela editando fuera de la app**. Lo que no puede es
    /// mantener el cambio: en cuanto el dueño sincroniza, su versión vuelve y la
    /// del otro queda a un lado como copia en conflicto.
    ///
    /// Solo debe llamarlo el **dueño** de la bóveda: su copia es la que manda.
    pub fn restaurar_bloqueadas(
        &self,
        previas: &HashMap<String, String>,
    ) -> Result<Vec<NotaRestaurada>, String> {
        let mut restauradas = Vec::new();
        for (id, mio) in previas {
            let ruta = self.ruta(id);
            let ahora = fs::read_to_string(&ruta).ok();
            if ahora.as_deref() == Some(mio.as_str()) {
                continue; // nadie la tocó
            }
            // Lo que venía de fuera no se tira: queda al lado para poder mirarlo.
            let mut copia = None;
            if let Some(ajeno) = ahora {
                let marca = Utc::now().format("%Y%m%d-%H%M%S");
                let nombre = format!("{id}.conflicto-{marca}.json");
                fs::write(self.dir.join(&nombre), ajeno).map_err(|e| e.to_string())?;
                copia = Some(nombre);
            }
            fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            fs::write(&ruta, mio).map_err(|e| e.to_string())?;

            let titulo = serde_json::from_str::<Documento>(mio)
                .map(|d| d.titulo)
                .unwrap_or_default();
            restauradas.push(NotaRestaurada { id: id.clone(), titulo, copia });
        }
        Ok(restauradas)
    }

    /// Rehace el índice entero a partir de los ficheros. Se llama al arrancar y
    /// tras traer cambios de otro equipo (`git pull`).
    pub fn reconstruir(&self, db: &Db) -> Result<usize, String> {
        let docs = self.listar_todos()?;
        db.reconstruir(&docs)?;
        Ok(docs.len())
    }

    /// Migración de un workspace anterior a este cambio: si no hay ni una nota en
    /// disco pero la BD tiene documentos, los vuelca a ficheros. No borra nada de
    /// la BD — pasa a ser el índice de lo que se acaba de escribir.
    pub fn migrar_desde_db(&self, db: &Db) -> Result<usize, String> {
        if !self.listar_todos()?.is_empty() {
            return Ok(0);
        }
        let resumenes = db.listar()?;
        let mut n = 0;
        for r in resumenes {
            if let Some(doc) = db.obtener(&r.id)? {
                self.escribir(&doc)?;
                n += 1;
            }
        }
        if n > 0 {
            log::info!("migradas {n} notas de workspace.db a notas/*.json");
        }
        Ok(n)
    }
}

/// Escribe el `.gitignore` del workspace si no existe, para que la carpeta se
/// pueda meter en git tal cual. Lo importante es excluir `workspace.db`: es un
/// índice reconstruible y versionarlo trae los conflictos de binario que este
/// diseño evita.
pub fn escribir_gitignore(workspace: &Path) -> Result<(), String> {
    let ruta = workspace.join(".gitignore");
    if ruta.exists() {
        return Ok(());
    }
    let contenido = "\
# Índice reconstruible a partir de notas/*.json — NO sincronizar.
# SQLite escribe en varios pasos no atómicos: copiarlo a media escritura lo
# parte, y un conflicto obliga a elegir un lado perdiendo el otro entero.
workspace.db
workspace.db-wal
workspace.db-shm

# Miniaturas: se regeneran a partir del original.
assets/*.prev.png
assets/*.prev.jpg

# Copias en conflicto de los sincronizadores.
*sync-conflict*

backups/
export/
";
    fs::write(&ruta, contenido).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Carpeta temporal propia por test (no hay dependencia de `tempfile`).
    struct Temporal(PathBuf);

    impl Temporal {
        fn nueva() -> Self {
            let dir = std::env::temp_dir().join(format!("nota-local-{}", Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn almacen(&self) -> Almacen {
            Almacen::nuevo(&self.0.join("notas")).unwrap()
        }
        fn db(&self) -> Db {
            Db::abrir(&self.0.join("workspace.db")).unwrap()
        }
    }

    impl Drop for Temporal {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn doc(titulo: &str) -> Documento {
        Documento {
            id: None,
            titulo: titulo.to_string(),
            icono: None,
            cover: None,
            tags: vec![],
            bloqueada: false,
            contenido: json!({ "type": "doc", "content": [] }),
            creado: None,
            modificado: None,
        }
    }

    #[test]
    fn guardar_crea_un_fichero_por_nota_y_se_relee_igual() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());

        let guardado = al.guardar(&db, doc("Reunión")).unwrap();
        let id = guardado.id.clone().unwrap();

        let leido = al.leer(&id).unwrap().expect("la nota debería existir");
        assert_eq!(leido.titulo, "Reunión");
        assert_eq!(leido.id, guardado.id);
        assert_eq!(leido.contenido, guardado.contenido);
    }

    #[test]
    fn el_json_va_indentado_para_que_el_diff_sea_legible() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        let mut d = doc("Notas");
        d.contenido = json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "hola" }] }]
        });

        let id = al.guardar(&db, d).unwrap().id.unwrap();
        let txt = fs::read_to_string(t.0.join("notas").join(format!("{id}.json"))).unwrap();

        // Varias líneas y sangría: un `git diff` señala la línea que cambió, no
        // el documento entero como pasaría con el JSON en una sola línea.
        assert!(txt.lines().count() > 5, "debería ocupar varias líneas:\n{txt}");
        assert!(txt.contains("\n  \"titulo\""), "sin sangría:\n{txt}");
    }

    #[test]
    fn guardar_dos_veces_el_mismo_contenido_da_el_mismo_fichero() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());

        let mut d = al.guardar(&db, doc("Estable")).unwrap();
        let ruta = t.0.join("notas").join(format!("{}.json", d.id.clone().unwrap()));
        let primero = fs::read_to_string(&ruta).unwrap();

        // Se reescribe con la misma fecha para aislar lo que se está midiendo:
        // que el orden de claves y etiquetas no baile entre guardados.
        d.tags = vec!["Trabajo".into(), "casa".into()];
        let d = al.guardar(&db, d).unwrap();
        let con_tags = fs::read_to_string(&ruta).unwrap();

        let mut otra_vez = d.clone();
        otra_vez.tags = vec!["casa".into(), "TRABAJO".into()]; // otro orden y caja
        al.guardar(&db, otra_vez).unwrap();
        let repetido = fs::read_to_string(&ruta).unwrap();

        assert_ne!(primero, con_tags, "añadir etiquetas sí debe cambiar el fichero");
        let sin_fecha = |s: &str| {
            s.lines()
                .filter(|l| !l.contains("\"modificado\""))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(
            sin_fecha(&con_tags),
            sin_fecha(&repetido),
            "las mismas etiquetas en otro orden no deberían ensuciar el diff"
        );
    }

    #[test]
    fn borrar_la_nota_borra_el_fichero() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        let id = al.guardar(&db, doc("Efímera")).unwrap().id.unwrap();
        let ruta = t.0.join("notas").join(format!("{id}.json"));
        assert!(ruta.exists());

        al.eliminar(&db, &id).unwrap();

        // Que el fichero desaparezca es lo que hace que el borrado viaje al otro
        // equipo: el sincronizador lo propaga sin tabla de lápidas.
        assert!(!ruta.exists());
        assert!(al.leer(&id).unwrap().is_none());
        assert!(db.obtener(&id).unwrap().is_none());
    }

    #[test]
    fn el_indice_se_reconstruye_desde_los_ficheros() {
        let t = Temporal::nueva();
        let al = t.almacen();
        {
            let db = t.db();
            al.guardar(&db, doc("Primera")).unwrap();
            al.guardar(&db, doc("Segunda")).unwrap();
        }

        // Se tira el índice entero, como si nunca hubiera existido (workspace
        // recién clonado de git: solo vienen los ficheros).
        fs::remove_file(t.0.join("workspace.db")).unwrap();
        let db = t.db();
        assert_eq!(db.listar().unwrap().len(), 0);

        assert_eq!(al.reconstruir(&db).unwrap(), 2);

        let titulos: Vec<String> = db.listar().unwrap().into_iter().map(|d| d.titulo).collect();
        assert!(titulos.contains(&"Primera".to_string()));
        assert!(titulos.contains(&"Segunda".to_string()));
    }

    #[test]
    fn la_busqueda_funciona_tras_reconstruir() {
        let t = Temporal::nueva();
        let al = t.almacen();
        let mut d = doc("Lista de la compra");
        d.contenido = json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "berenjenas" }] }]
        });
        {
            let db = t.db();
            al.guardar(&db, d).unwrap();
        }
        fs::remove_file(t.0.join("workspace.db")).unwrap();

        let db = t.db();
        al.reconstruir(&db).unwrap();

        // El FTS5 es parte del índice derivado: si no se rehace, buscar deja de
        // encontrar notas que sí están en disco.
        assert_eq!(db.buscar("berenjenas").unwrap().len(), 1);
        assert_eq!(db.buscar("compra").unwrap().len(), 1);
    }

    #[test]
    fn reconstruir_refleja_lo_que_llego_de_fuera() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        let id = al.guardar(&db, doc("Local")).unwrap().id.unwrap();

        // Lo que haría un `git pull`: una nota nueva aparece en disco y otra
        // desaparece, sin que la app se entere.
        let ajena = json!({
            "id": "11111111-2222-3333-4444-555555555555",
            "titulo": "Del portátil",
            "tags": [],
            "contenido": { "type": "doc", "content": [] },
            "creado": "2026-01-01T00:00:00Z",
            "modificado": "2026-01-01T00:00:00Z"
        });
        fs::write(
            t.0.join("notas").join("11111111-2222-3333-4444-555555555555.json"),
            serde_json::to_string_pretty(&ajena).unwrap(),
        )
        .unwrap();
        fs::remove_file(t.0.join("notas").join(format!("{id}.json"))).unwrap();

        al.reconstruir(&db).unwrap();

        let titulos: Vec<String> = db.listar().unwrap().into_iter().map(|d| d.titulo).collect();
        assert_eq!(titulos, vec!["Del portátil".to_string()]);
        assert!(db.obtener(&id).unwrap().is_none(), "la borrada fuera debe irse del índice");
    }

    #[test]
    fn las_copias_en_conflicto_no_duplican_la_nota() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        let id = al.guardar(&db, doc("Original")).unwrap().id.unwrap();

        // Syncthing deja la versión del otro equipo al lado, con el MISMO id
        // dentro. Leerla duplicaría (o pisaría) la nota según el orden del
        // directorio; se queda en disco para que el usuario decida.
        let original = fs::read_to_string(t.0.join("notas").join(format!("{id}.json"))).unwrap();
        fs::write(
            t.0.join("notas").join(format!("{id}.sync-conflict-20260101-120000-ABCDEF.json")),
            original.replace("Original", "Versión del portátil"),
        )
        .unwrap();

        al.reconstruir(&db).unwrap();

        let docs = db.listar().unwrap();
        assert_eq!(docs.len(), 1, "la copia en conflicto no debe entrar en la biblioteca");
        assert_eq!(docs[0].titulo, "Original");
    }

    #[test]
    fn un_fichero_roto_no_se_lleva_por_delante_el_resto() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        al.guardar(&db, doc("Buena")).unwrap();
        fs::write(t.0.join("notas").join("rota.json"), "{ esto no es JSON").unwrap();

        assert_eq!(al.reconstruir(&db).unwrap(), 1);
        assert_eq!(db.listar().unwrap().len(), 1);
    }

    #[test]
    fn migrar_vuelca_las_notas_de_la_bd_a_ficheros() {
        let t = Temporal::nueva();
        let db = t.db();
        // Workspace anterior a este cambio: las notas solo viven en SQLite.
        db.indexar(&Documento {
            id: Some("aaaa-bbbb".into()),
            titulo: "Antigua".into(),
            icono: None,
            cover: None,
            tags: vec!["viejo".into()],
            bloqueada: false,
            contenido: json!({ "type": "doc", "content": [] }),
            creado: Some("2026-01-01T00:00:00Z".into()),
            modificado: Some("2026-01-01T00:00:00Z".into()),
        })
        .unwrap();

        let al = t.almacen();
        assert_eq!(al.migrar_desde_db(&db).unwrap(), 1);

        let leido = al.leer("aaaa-bbbb").unwrap().unwrap();
        assert_eq!(leido.titulo, "Antigua");
        assert_eq!(leido.tags, vec!["viejo".to_string()]);

        // Idempotente: al siguiente arranque ya hay ficheros y no vuelve a volcar.
        assert_eq!(al.migrar_desde_db(&db).unwrap(), 0);
    }

    #[test]
    fn un_id_con_rutas_no_escribe_fuera_de_notas() {
        let t = Temporal::nueva();
        let (al, db) = (t.almacen(), t.db());
        let mut d = doc("Traviesa");
        d.id = Some("../../fuera".into());

        assert!(al.guardar(&db, d).is_err());
        assert!(!t.0.join("fuera.json").exists());
    }

    #[test]
    fn el_gitignore_excluye_el_indice() {
        let t = Temporal::nueva();
        escribir_gitignore(&t.0).unwrap();
        let txt = fs::read_to_string(t.0.join(".gitignore")).unwrap();
        assert!(txt.contains("workspace.db"));
        assert!(!txt.contains("\nnotas/"), "las notas SÍ se versionan");
    }
}

#[cfg(test)]
mod tests_bloqueo {
    use super::*;
    use serde_json::json;

    fn temporal() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bloqueo-{}", Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn doc(titulo: &str, bloqueada: bool) -> Documento {
        Documento {
            id: None,
            titulo: titulo.into(),
            icono: None,
            cover: None,
            tags: vec![],
            bloqueada,
            contenido: json!({ "type": "doc", "content": [] }),
            creado: None,
            modificado: None,
        }
    }

    #[test]
    fn la_marca_de_bloqueo_sobrevive_al_disco() {
        let raiz = temporal();
        let db = Db::abrir(&raiz.join("w.db")).unwrap();
        let al = Almacen::nuevo(&raiz.join("notas")).unwrap();

        let id = al.guardar(&db, doc("Manual", true)).unwrap().id.unwrap();
        assert!(al.leer(&id).unwrap().unwrap().bloqueada);
        // Y también llega al listado, para pintar el candado sin abrir la nota.
        assert!(db.listar().unwrap()[0].bloqueada);

        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn una_nota_bloqueada_cambiada_por_otro_vuelve_a_su_sitio() {
        let raiz = temporal();
        let db = Db::abrir(&raiz.join("w.db")).unwrap();
        let al = Almacen::nuevo(&raiz.join("notas")).unwrap();
        let id = al.guardar(&db, doc("Manual del equipo", true)).unwrap().id.unwrap();

        let previas = al.instantanea_bloqueadas().unwrap();

        // Un colaborador la edita por fuera de la app y su cambio llega al hacer
        // pull: el candado no se lo impide, git no sabe nada de él.
        let ruta = raiz.join("notas").join(format!("{id}.json"));
        let ajena = fs::read_to_string(&ruta).unwrap().replace("Manual del equipo", "Manipulado");
        fs::write(&ruta, &ajena).unwrap();

        let restauradas = al.restaurar_bloqueadas(&previas).unwrap();

        assert_eq!(restauradas.len(), 1);
        assert_eq!(restauradas[0].id, id);
        // El aviso lleva el título: un UUID no le dice nada al usuario.
        assert_eq!(restauradas[0].titulo, "Manual del equipo");
        assert!(restauradas[0].copia.is_some(), "y dónde quedó la versión ajena");
        assert_eq!(al.leer(&id).unwrap().unwrap().titulo, "Manual del equipo");

        // La versión ajena no se tira: queda al lado para poder mirarla.
        let copia = fs::read_dir(raiz.join("notas"))
            .unwrap()
            .flatten()
            .find(|f| f.file_name().to_string_lossy().contains("conflicto"))
            .expect("debería quedar la versión del otro");
        assert!(fs::read_to_string(copia.path()).unwrap().contains("Manipulado"));

        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn una_nota_bloqueada_borrada_por_otro_reaparece() {
        let raiz = temporal();
        let db = Db::abrir(&raiz.join("w.db")).unwrap();
        let al = Almacen::nuevo(&raiz.join("notas")).unwrap();
        let id = al.guardar(&db, doc("No borrar", true)).unwrap().id.unwrap();
        let previas = al.instantanea_bloqueadas().unwrap();

        fs::remove_file(raiz.join("notas").join(format!("{id}.json"))).unwrap();

        let restauradas = al.restaurar_bloqueadas(&previas).unwrap();
        assert_eq!(restauradas.len(), 1);
        assert_eq!(restauradas[0].id, id);
        // Borrada, así que no hay versión ajena que guardar al lado.
        assert!(restauradas[0].copia.is_none());
        assert_eq!(al.leer(&id).unwrap().unwrap().titulo, "No borrar");

        let _ = fs::remove_dir_all(&raiz);
    }

    #[test]
    fn las_notas_sin_bloquear_no_se_restauran() {
        let raiz = temporal();
        let db = Db::abrir(&raiz.join("w.db")).unwrap();
        let al = Almacen::nuevo(&raiz.join("notas")).unwrap();
        let id = al.guardar(&db, doc("Trabajo en equipo", false)).unwrap().id.unwrap();

        let previas = al.instantanea_bloqueadas().unwrap();
        assert!(previas.is_empty(), "solo se vigilan las bloqueadas");

        // El equipo edita libremente lo que no tiene candado.
        let ruta = raiz.join("notas").join(format!("{id}.json"));
        fs::write(&ruta, fs::read_to_string(&ruta).unwrap().replace("Trabajo", "Aporte")).unwrap();

        assert!(al.restaurar_bloqueadas(&previas).unwrap().is_empty());
        assert_eq!(al.leer(&id).unwrap().unwrap().titulo, "Aporte en equipo");

        let _ = fs::remove_dir_all(&raiz);
    }
}
