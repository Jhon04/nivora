use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::almacen::normalizar_tag;
use crate::models::{Documento, DocumentoResumen, ResultadoBusqueda, TagInfo};

/// Esquema inicial. `contenido` es TEXT con el JSON de bloques del editor.
const ESQUEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS document (
    id          TEXT PRIMARY KEY,
    titulo      TEXT NOT NULL DEFAULT '',
    icono       TEXT,
    cover       TEXT,
    contenido   TEXT NOT NULL DEFAULT '[]',
    creado      TEXT NOT NULL,
    modificado  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag (
    id      TEXT PRIMARY KEY,
    nombre  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS document_tag (
    document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    tag_id      TEXT NOT NULL REFERENCES tag(id)      ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS asset (
    id    TEXT PRIMARY KEY,
    tipo  TEXT NOT NULL,
    ruta  TEXT NOT NULL,
    hash  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_modificado ON document(modificado DESC);

-- Índice de texto completo. `doc_id` no se indexa (solo lo guardamos para
-- enlazar con document); se busca sobre `titulo` y `texto` (texto plano
-- extraído del JSON de bloques). remove_diacritics 2 => búsqueda sin acentos.
CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
    doc_id UNINDEXED,
    titulo,
    texto,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

/// Recorre el JSON de bloques (Tiptap) y concatena todo el texto de los nodos
/// de texto para indexarlo. Cualquier valor bajo la clave `"text"` se acumula.
fn extraer_texto(valor: &serde_json::Value, salida: &mut String) {
    match valor {
        serde_json::Value::Object(mapa) => {
            if let Some(serde_json::Value::String(t)) = mapa.get("text") {
                salida.push_str(t);
                salida.push(' ');
            }
            for (clave, v) in mapa {
                if clave != "text" {
                    extraer_texto(v, salida);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                extraer_texto(item, salida);
            }
        }
        _ => {}
    }
}

/// Reemplaza las etiquetas de un documento: borra las relaciones anteriores,
/// crea las etiquetas que falten y enlaza las nuevas. Poda las que se quedan
/// sin ningún documento.
fn sincronizar_tags(conn: &Connection, doc_id: &str, tags: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM document_tag WHERE document_id = ?1", params![doc_id])
        .map_err(|e| e.to_string())?;

    let mut vistos = std::collections::HashSet::new();
    for tag in tags {
        let nombre = normalizar_tag(tag);
        if nombre.is_empty() || !vistos.insert(nombre.clone()) {
            continue;
        }
        conn.execute(
            "INSERT INTO tag (id, nombre) VALUES (?1, ?2) ON CONFLICT(nombre) DO NOTHING",
            params![Uuid::new_v4().to_string(), nombre],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO document_tag (document_id, tag_id)
             SELECT ?1, id FROM tag WHERE nombre = ?2",
            params![doc_id, nombre],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "DELETE FROM tag WHERE id NOT IN (SELECT tag_id FROM document_tag)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Etiquetas (nombres) de un documento, ordenadas.
fn tags_de(conn: &Connection, doc_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.nombre FROM tag t
               JOIN document_tag dt ON dt.tag_id = t.id
              WHERE dt.document_id = ?1
              ORDER BY t.nombre",
        )
        .map_err(|e| e.to_string())?;
    let filas = stmt
        .query_map(params![doc_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut v = Vec::new();
    for f in filas {
        v.push(f.map_err(|e| e.to_string())?);
    }
    Ok(v)
}

/// Vuelca un documento en el índice: fila, texto para el FTS y etiquetas. Es un
/// upsert, así que la misma llamada vale para una nota recién creada y para una
/// que ya estaba. Recibe `&Connection` (no `&Db`) para poder usarse también
/// dentro de la transacción de `reconstruir`.
fn indexar_en(conn: &Connection, doc: &Documento) -> Result<(), String> {
    let id = doc.id.as_deref().ok_or("documento sin id")?;
    let contenido = doc.contenido.to_string();
    let ahora = Utc::now().to_rfc3339();
    let creado = doc.creado.clone().unwrap_or_else(|| ahora.clone());
    let modificado = doc.modificado.clone().unwrap_or(ahora);

    conn.execute(
        "INSERT INTO document (id, titulo, icono, cover, contenido, creado, modificado)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
              titulo = ?2, icono = ?3, cover = ?4, contenido = ?5, modificado = ?7",
        params![id, doc.titulo, doc.icono, doc.cover, contenido, creado, modificado],
    )
    .map_err(|e| e.to_string())?;

    let mut texto = String::new();
    extraer_texto(&doc.contenido, &mut texto);
    conn.execute("DELETE FROM document_fts WHERE doc_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO document_fts (doc_id, titulo, texto) VALUES (?1, ?2, ?3)",
        params![id, doc.titulo, texto],
    )
    .map_err(|e| e.to_string())?;

    sincronizar_tags(conn, id, &doc.tags)
}

/// Dueña de la conexión SQLite. Se registra como estado de Tauri (`app.manage`)
/// y los comandos la reciben vía `State<Db>`.
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn abrir(ruta: &Path) -> Result<Self, String> {
        let conn = Connection::open(ruta).map_err(|e| e.to_string())?;
        conn.execute_batch(ESQUEMA).map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Refleja un documento en el índice. **No** genera id ni fechas: de eso se
    /// encarga `Almacen` antes de escribir el fichero, que es la fuente de
    /// verdad. Aquí solo se copia lo que ya está en disco.
    pub fn indexar(&self, doc: &Documento) -> Result<(), String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        indexar_en(&conn, doc)
    }

    /// Rehace el índice entero a partir de las notas del disco. Todo lo que hay
    /// en estas tablas es derivado, así que se vacían sin miedo: lo que no esté
    /// en `notas/` no existe. En una transacción, para no dejar media biblioteca
    /// si falla a mitad.
    pub fn reconstruir(&self, docs: &[Documento]) -> Result<(), String> {
        let mut conn = self.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for tabla in ["document_tag", "tag", "document_fts", "document"] {
            tx.execute(&format!("DELETE FROM {tabla}"), [])
                .map_err(|e| e.to_string())?;
        }
        for doc in docs {
            indexar_en(&tx, doc)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Rehace la tabla `asset` recorriendo `assets/`. El nombre del fichero es
    /// `<sha256>.<ext>`, así que el directorio ya lo dice todo: las imágenes que
    /// llegan de otro equipo quedan registradas sin pedirle nada al usuario.
    pub fn reconstruir_assets(&self, dir: &Path) -> Result<usize, String> {
        let entradas = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return Ok(0),
        };
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM asset", []).map_err(|e| e.to_string())?;
        let mut n = 0;
        for entrada in entradas.flatten() {
            let nombre = entrada.file_name().to_string_lossy().into_owned();
            let partes: Vec<&str> = nombre.split('.').collect();
            // Solo `<hash>.<ext>`: `<hash>.prev.jpg` es una miniatura derivada.
            if partes.len() != 2 || partes[0].len() != 64 {
                continue;
            }
            conn.execute(
                "INSERT INTO asset (id, tipo, ruta, hash) VALUES (?1, ?2, ?3, ?4)",
                params![Uuid::new_v4().to_string(), partes[1], nombre, partes[0]],
            )
            .map_err(|e| e.to_string())?;
            n += 1;
        }
        Ok(n)
    }

    pub fn obtener(&self, id: &str) -> Result<Option<Documento>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let doc = conn
            .query_row(
                "SELECT id, titulo, icono, cover, contenido, creado, modificado
                   FROM document WHERE id = ?1",
                params![id],
                |fila| {
                    let contenido: String = fila.get(4)?;
                    Ok(Documento {
                        id: Some(fila.get(0)?),
                        titulo: fila.get(1)?,
                        icono: fila.get(2)?,
                        cover: fila.get(3)?,
                        tags: Vec::new(),
                        contenido: serde_json::from_str(&contenido)
                            .unwrap_or_else(|_| serde_json::json!([])),
                        creado: Some(fila.get(5)?),
                        modificado: Some(fila.get(6)?),
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match doc {
            Some(mut d) => {
                d.tags = tags_de(&conn, id)?;
                Ok(Some(d))
            }
            None => Ok(None),
        }
    }

    pub fn listar(&self) -> Result<Vec<DocumentoResumen>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.titulo, d.icono, d.modificado,
                        (SELECT group_concat(t.nombre, ',')
                           FROM document_tag dt JOIN tag t ON t.id = dt.tag_id
                          WHERE dt.document_id = d.id) AS tags
                   FROM document d
                  ORDER BY d.modificado DESC",
            )
            .map_err(|e| e.to_string())?;
        let filas = stmt
            .query_map([], |fila| {
                let tags: Option<String> = fila.get(4)?;
                Ok(DocumentoResumen {
                    id: fila.get(0)?,
                    titulo: fila.get(1)?,
                    icono: fila.get(2)?,
                    modificado: fila.get(3)?,
                    tags: tags
                        .map(|s| s.split(',').map(|x| x.to_string()).collect())
                        .unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut docs = Vec::new();
        for d in filas {
            docs.push(d.map_err(|e| e.to_string())?);
        }
        Ok(docs)
    }

    /// Todas las etiquetas con su número de usos (para autocompletado/filtro).
    pub fn listar_tags(&self) -> Result<Vec<TagInfo>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT t.nombre, count(dt.document_id) AS usos
                   FROM tag t
                   LEFT JOIN document_tag dt ON dt.tag_id = t.id
                  GROUP BY t.id
                  ORDER BY t.nombre",
            )
            .map_err(|e| e.to_string())?;
        let filas = stmt
            .query_map([], |r| {
                Ok(TagInfo {
                    nombre: r.get(0)?,
                    usos: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        for t in filas {
            tags.push(t.map_err(|e| e.to_string())?);
        }
        Ok(tags)
    }

    pub fn eliminar(&self, id: &str) -> Result<(), String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM document WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM document_fts WHERE doc_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Búsqueda de texto completo. Cada palabra se convierte en un término con
    /// prefijo (`"palabra"*`) para ir filtrando según se escribe. Devuelve hasta
    /// 50 resultados ordenados por relevancia (`rank` de FTS5).
    pub fn buscar(&self, consulta: &str) -> Result<Vec<ResultadoBusqueda>, String> {
        let terminos: Vec<String> = consulta
            .split_whitespace()
            .map(|t| t.replace('"', ""))
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*"))
            .collect();
        if terminos.is_empty() {
            return Ok(Vec::new());
        }
        let match_query = terminos.join(" ");

        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT d.id,
                        highlight(document_fts, 1, char(2), char(3)) AS titulo,
                        d.icono, d.modificado,
                        snippet(document_fts, 2, char(2), char(3), '…', 12) AS fragmento
                   FROM document_fts
                   JOIN document d ON d.id = document_fts.doc_id
                  WHERE document_fts MATCH ?1
                  ORDER BY rank
                  LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let filas = stmt
            .query_map(params![match_query], |fila| {
                Ok(ResultadoBusqueda {
                    id: fila.get(0)?,
                    titulo: fila.get(1)?,
                    icono: fila.get(2)?,
                    modificado: fila.get(3)?,
                    fragmento: fila.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut resultados = Vec::new();
        for f in filas {
            resultados.push(f.map_err(|e| e.to_string())?);
        }
        Ok(resultados)
    }

    /// Registra un asset. Si ya existe uno con el mismo hash, reutiliza su id
    /// (deduplicación por contenido). Devuelve el id.
    pub fn guardar_asset(&self, tipo: &str, ruta: &str, hash: &str) -> Result<String, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let existente: Option<String> = conn
            .query_row("SELECT id FROM asset WHERE hash = ?1", params![hash], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(id) = existente {
            return Ok(id);
        }
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO asset (id, tipo, ruta, hash) VALUES (?1, ?2, ?3, ?4)",
            params![id, tipo, ruta, hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    }
}
