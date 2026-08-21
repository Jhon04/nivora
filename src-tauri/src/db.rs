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
    modificado  TEXT NOT NULL,
    bloqueada   INTEGER NOT NULL DEFAULT 0
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

/// Palabras que introducen un nombre puesto por la persona, no sintaxis: lo que
/// va detrás es texto buscable; la palabra en sí, no.
const CLAVES_MERMAID: [&str; 6] = [
    "title",
    "section",
    "participant",
    "actor",
    "subgraph",
    "class",
];

/// Líneas que solo dicen cómo se pinta el diagrama. No contienen nada que nadie
/// vaya a buscar, y `click` además es la directiva que puede abrir un enlace,
/// así que ni se mira.
const LINEAS_DE_ADORNO: [&str; 4] = ["style", "classDef", "linkStyle", "click"];

/// Caracteres que solo dan forma al nodo y nunca son parte de la etiqueta.
const ADORNOS: &[char] = &['[', ']', '(', ')', '{', '}', '|', '/', '\\', '"', '\''];

/// El cierre que corresponde a cada apertura de etiqueta.
fn cierre_de(c: char) -> Option<char> {
    match c {
        '[' => Some(']'),
        '(' => Some(')'),
        '{' => Some('}'),
        // `|` abre y cierra con el mismo carácter (etiquetas de flecha).
        '|' => Some('|'),
        _ => None,
    }
}

/// Texto **legible** de un diagrama Mermaid: lo que alguien escribió y luego va
/// a buscar.
///
/// Se queda con lo que va dentro de delimitadores (`[Servidor web]`,
/// `(Base de datos)`, `{¿Autenticado?}`, `|reintenta|`), con lo que sigue a las
/// palabras de `CLAVES_MERMAID`, y con lo que sigue a `:` en las líneas sin
/// delimitadores (`Alice->>Bob: Hola`).
///
/// Lo importante es lo que deja fuera. `graph`, `TD`, `-->`, `end` y los
/// identificadores sueltos (`A`, `B`) no van nunca entre delimitadores, así que
/// no llegan al índice. Sin este filtro, buscar "graph" devolvería todas las
/// notas que tuvieran un diagrama, y el buscador dejaría de servir.
///
/// Es una heurística, no un analizador de Mermaid: cubre los diagramas de flujo
/// y de secuencia, que son casi todo lo que se usa. Un `gantt` deja fuera parte
/// de sus nombres — se prefiere perder alguna palabra a meter ruido, porque el
/// ruido en un índice FTS no se puede filtrar después.
fn extraer_etiquetas_mermaid(codigo: &str, salida: &mut String) {
    let mut anadir = |t: &str| {
        let limpio = t.trim_matches(|c: char| ADORNOS.contains(&c) || c.is_whitespace());
        if !limpio.is_empty() {
            salida.push_str(limpio);
            salida.push(' ');
        }
    };

    for linea in codigo.lines() {
        let recortada = linea.trim();
        if recortada.is_empty() || LINEAS_DE_ADORNO.iter().any(|p| recortada.starts_with(p)) {
            continue;
        }

        // Palabra clave: el nombre va detrás y termina donde empiece un
        // delimitador, para que `subgraph Red [Producción]` dé «Red» aquí y
        // «Producción» en el barrido de abajo, sin repetir ninguna.
        for clave in CLAVES_MERMAID {
            let Some(resto) = recortada.strip_prefix(clave) else {
                continue;
            };
            // Sin el espacio, `classDiagram` pasaría por un `class …`.
            if !resto.starts_with(char::is_whitespace) {
                continue;
            }
            let hasta = resto
                .find(|c: char| cierre_de(c).is_some())
                .unwrap_or(resto.len());
            anadir(&resto[..hasta]);
            break;
        }

        // Barrido de delimitadores. Cuenta el anidamiento del mismo par para que
        // `A((Círculo))` se capture entero en vez de cortarse en el primer `)`.
        let chars: Vec<char> = recortada.chars().collect();
        let mut i = 0;
        let mut hubo_delimitador = false;
        while i < chars.len() {
            let apertura = chars[i];
            let Some(cierre) = cierre_de(apertura) else {
                i += 1;
                continue;
            };
            let mut profundidad = 1;
            let mut j = i + 1;
            while j < chars.len() && profundidad > 0 {
                if chars[j] == cierre {
                    profundidad -= 1;
                } else if chars[j] == apertura && apertura != cierre {
                    profundidad += 1;
                }
                j += 1;
            }
            if profundidad == 0 {
                hubo_delimitador = true;
                anadir(&chars[i + 1..j - 1].iter().collect::<String>());
                i = j;
            } else {
                // Delimitador sin cerrar: el usuario está a medias de escribir,
                // no es una etiqueta todavía.
                i += 1;
            }
        }

        // `Alice->>Bob: Hola` — el mensaje va detrás de los dos puntos. Solo en
        // líneas sin delimitadores: si los hay, el texto legible ya ha salido de
        // ellos y lo que sigue a `:` suele ser metadato.
        if !hubo_delimitador {
            if let Some((_, resto)) = recortada.split_once(':') {
                anadir(resto);
            }
        }
    }
}

/// Recorre el JSON de bloques (Tiptap) y concatena todo el texto de los nodos
/// de texto para indexarlo. Cualquier valor bajo la clave `"text"` se acumula.
fn extraer_texto(valor: &serde_json::Value, salida: &mut String) {
    match valor {
        serde_json::Value::Object(mapa) => {
            /* Un diagrama guarda su fuente en `attrs.codigo`, que la regla
               general no ve (solo mira las claves `text`). Ese silencio no
               sirve: sin tocar nada, los diagramas serían invisibles para la
               búsqueda y no habría forma de encontrar «la nota del diagrama de
               despliegue». Se indexan sus etiquetas, nunca su sintaxis. */
            /* Un esquema guarda su grafo en `attrs.datos`, y sus etiquetas van
               bajo la clave `texto`, no `text`: la regla general pasa de largo.
               Aquí no hace falta heurística ninguna —al revés que con Mermaid—
               porque el formato es nuestro y los textos ya son campos limpios,
               sin sintaxis alrededor de la que separarlos. */
            if mapa.get("type").and_then(|v| v.as_str()) == Some("esquema") {
                let datos = mapa.get("attrs").and_then(|a| a.get("datos"));
                for lista in ["nodos", "conexiones"] {
                    let Some(items) = datos.and_then(|d| d.get(lista)).and_then(|v| v.as_array())
                    else {
                        continue;
                    };
                    for item in items {
                        if let Some(t) = item.get("texto").and_then(|v| v.as_str()) {
                            if !t.trim().is_empty() {
                                salida.push_str(t);
                                salida.push(' ');
                            }
                        }
                        /* Una tabla lleva además sus columnas. Se indexa el
                           NOMBRE y no el tipo a propósito: quien busca en sus
                           notas busca `cliente_id`, no `varchar`, y meter los
                           tipos llenaría el índice de palabras que salen en
                           todas las tablas y no distinguen ninguna. */
                        let Some(columnas) =
                            item.get("columnas").and_then(|v| v.as_array())
                        else {
                            continue;
                        };
                        for columna in columnas {
                            if let Some(n) = columna.get("nombre").and_then(|v| v.as_str()) {
                                if !n.trim().is_empty() {
                                    salida.push_str(n);
                                    salida.push(' ');
                                }
                            }
                        }
                    }
                }
                // Es un `atom`: no hay nada dentro que recorrer.
                return;
            }

            if mapa.get("type").and_then(|v| v.as_str()) == Some("diagrama") {
                if let Some(codigo) = mapa
                    .get("attrs")
                    .and_then(|a| a.get("codigo"))
                    .and_then(|c| c.as_str())
                {
                    extraer_etiquetas_mermaid(codigo, salida);
                }
                // Es un `atom`: no hay nada dentro que recorrer.
                return;
            }
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
        "INSERT INTO document (id, titulo, icono, cover, contenido, creado, modificado, bloqueada)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
              titulo = ?2, icono = ?3, cover = ?4, contenido = ?5, modificado = ?7,
              bloqueada = ?8",
        params![id, doc.titulo, doc.icono, doc.cover, contenido, creado, modificado, doc.bloqueada],
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

/// Añade las columnas que hayan aparecido después de crear la base.
///
/// `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya existe, así que sin
/// esto una base creada por una versión anterior se quedaría sin la columna
/// nueva y **todas las consultas fallarían al arrancar**.
fn migrar_columnas(conn: &Connection) -> Result<(), String> {
    let tiene = |columna: &str| -> Result<bool, String> {
        let mut stmt = conn
            .prepare("SELECT 1 FROM pragma_table_info('document') WHERE name = ?1")
            .map_err(|e| e.to_string())?;
        stmt.exists(params![columna]).map_err(|e| e.to_string())
    };
    if !tiene("bloqueada")? {
        conn.execute(
            "ALTER TABLE document ADD COLUMN bloqueada INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
        log::info!("índice migrado: columna `bloqueada`");
    }
    Ok(())
}

/// Dueña de la conexión SQLite. Se registra como estado de Tauri (`app.manage`)
/// y los comandos la reciben vía `State<Db>`.
pub struct Db(Mutex<Connection>);

impl Db {
    pub fn abrir(ruta: &Path) -> Result<Self, String> {
        let conn = Connection::open(ruta).map_err(|e| e.to_string())?;
        conn.execute_batch(ESQUEMA).map_err(|e| e.to_string())?;
        migrar_columnas(&conn)?;
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
                "SELECT id, titulo, icono, cover, contenido, creado, modificado, bloqueada
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
                        bloqueada: fila.get(7)?,
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
                          WHERE dt.document_id = d.id) AS tags,
                        d.bloqueada
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
                    bloqueada: fila.get(5)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// El índice es derivado, pero **no** se recrea de cero al arrancar: solo se
    /// vacían las filas. Sin migrar las columnas, una base de una versión
    /// anterior rompería todas las consultas nada más abrir la app.
    #[test]
    fn una_base_antigua_gana_las_columnas_nuevas() {
        let ruta = std::env::temp_dir().join(format!("db-vieja-{}.db", Uuid::new_v4()));
        {
            // Esquema anterior: sin `bloqueada`.
            let conn = Connection::open(&ruta).unwrap();
            conn.execute_batch(
                "CREATE TABLE document (
                     id TEXT PRIMARY KEY, titulo TEXT NOT NULL DEFAULT '',
                     icono TEXT, cover TEXT, contenido TEXT NOT NULL DEFAULT '[]',
                     creado TEXT NOT NULL, modificado TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO document (id, titulo, contenido, creado, modificado)
                 VALUES ('a', 'Antigua', '{}', '2026-01-01', '2026-01-01')",
                [],
            )
            .unwrap();
        }

        let db = Db::abrir(&ruta).expect("abrir una base antigua no puede fallar");
        let docs = db.listar().expect("listar tampoco");

        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].titulo, "Antigua");
        assert!(!docs[0].bloqueada, "las notas de antes no están bloqueadas");

        let _ = std::fs::remove_file(&ruta);
    }

    /// Atajo: las etiquetas de un fragmento de Mermaid, ya separadas.
    fn etiquetas(codigo: &str) -> Vec<String> {
        let mut s = String::new();
        extraer_etiquetas_mermaid(codigo, &mut s);
        s.split_whitespace().map(str::to_owned).collect()
    }

    /// La razón de ser de todo esto. Si la sintaxis entrara al índice, buscar
    /// "graph" devolvería cualquier nota con un diagrama y el buscador dejaría
    /// de distinguir nada.
    #[test]
    fn la_sintaxis_del_diagrama_no_entra_en_el_indice() {
        let ls = etiquetas("graph TD\n  A[Servidor] --> B[Base de datos]\n  end");

        for ruido in ["graph", "TD", "-->", "end", "A", "B"] {
            assert!(
                !ls.iter().any(|t| t == ruido),
                "«{ruido}» es sintaxis y no debería indexarse; salió {ls:?}"
            );
        }
    }

    /// …y la otra mitad: lo que la persona escribió sí tiene que poder buscarse.
    #[test]
    fn las_etiquetas_escritas_a_mano_si_se_indexan() {
        let ls = etiquetas("graph TD\n  A[Servidor web] --> B[Base de datos]");
        let texto = ls.join(" ");

        assert!(texto.contains("Servidor web"), "salió {ls:?}");
        assert!(texto.contains("Base de datos"), "salió {ls:?}");
    }

    /// Cada forma de nodo trae sus propios adornos alrededor del texto. Ninguno
    /// puede acabar pegado a la palabra, o la búsqueda no la encontraría.
    #[test]
    fn las_formas_no_dejan_adornos_pegados_a_la_etiqueta() {
        let ls = etiquetas(
            "flowchart LR\n\
             A((Círculo))\n\
             B[/Paralelogramo/]\n\
             C{{Hexágono}}\n\
             D{Rombo}\n\
             E -->|reintenta| F",
        );

        for esperada in ["Círculo", "Paralelogramo", "Hexágono", "Rombo", "reintenta"] {
            assert!(
                ls.iter().any(|t| t == esperada),
                "faltaba «{esperada}» limpia; salió {ls:?}"
            );
        }
    }

    /// En un diagrama de secuencia el texto no va entre corchetes: va detrás de
    /// los dos puntos, y los nombres detrás de `participant`.
    #[test]
    fn el_diagrama_de_secuencia_indexa_mensajes_y_participantes() {
        let ls = etiquetas(
            "sequenceDiagram\n\
             participant Almacén\n\
             Alice->>Bob: Pedido aceptado",
        );
        let texto = ls.join(" ");

        assert!(texto.contains("Almacén"), "salió {ls:?}");
        assert!(texto.contains("Pedido aceptado"), "salió {ls:?}");
        assert!(
            !ls.iter().any(|t| t == "sequenceDiagram"),
            "la palabra del tipo de diagrama es sintaxis; salió {ls:?}"
        );
    }

    /// Los colores no son contenido. `click` además es la directiva que abre
    /// enlaces: no indexarla evita que una URL de otra persona aparezca como
    /// resultado de búsqueda en una bóveda compartida.
    #[test]
    fn las_lineas_de_estilo_y_click_se_ignoran() {
        let ls = etiquetas(
            "graph TD\n\
             A[Real]\n\
             style A fill:#f9f\n\
             click A href \"https://ejemplo.invalido\"",
        );

        assert_eq!(ls, vec!["Real"], "solo la etiqueta de verdad; salió {ls:?}");
    }

    /// `subgraph Red [Producción]` tiene nombre en dos sitios. Los dos valen, y
    /// ninguno puede salir repetido.
    #[test]
    fn el_subgrafo_aporta_sus_dos_nombres_sin_repetir() {
        let ls = etiquetas("graph TD\n  subgraph Red [Producción]\n  end");

        assert_eq!(ls, vec!["Red", "Producción"], "salió {ls:?}");
    }

    /// Un delimitador a medio escribir no es una etiqueta. Pasa en cada
    /// pulsación mientras se teclea, así que no puede reventar ni colarse.
    #[test]
    fn un_corchete_sin_cerrar_no_rompe_la_extraccion() {
        assert_eq!(etiquetas("graph TD\n  A[a medio escrib"), Vec::<String>::new());
    }

    /// El esquema guarda sus etiquetas bajo `texto`, no bajo `text`, así que sin
    /// su rama en `extraer_texto` un diagrama dibujado a mano sería invisible
    /// para la búsqueda por completo.
    #[test]
    fn un_esquema_indexa_los_nodos_y_las_flechas() {
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "esquema",
                "attrs": { "datos": {
                    "nodos": [
                        { "id": "a", "x": 0, "y": 0, "texto": "Pasarela de pago", "forma": "proceso" },
                        { "id": "b", "x": 200, "y": 0, "texto": "", "forma": "decision" }
                    ],
                    "conexiones": [{ "id": "c1", "desde": "a", "hasta": "b", "texto": "si falla" }]
                }}
            }]
        });

        let mut texto = String::new();
        extraer_texto(&doc, &mut texto);

        assert!(texto.contains("Pasarela de pago"), "salió «{texto}»");
        assert!(texto.contains("si falla"), "la etiqueta de la flecha; salió «{texto}»");
        // Ni ids ni coordenadas: son datos de dibujo, no algo que nadie busque.
        assert!(!texto.contains('a') || !texto.contains("200"), "sin ids ni posiciones");
    }

    /// Una tabla guarda sus campos en `columnas`, fuera de `texto`. Sin esta
    /// rama, buscar por el nombre de una columna no encontraría el diagrama de
    /// base de datos donde está dibujada — que es justo para lo que se dibuja.
    #[test]
    fn una_tabla_indexa_los_nombres_de_sus_columnas() {
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "esquema",
                "attrs": { "datos": {
                    "nodos": [{
                        "id": "t", "x": 0, "y": 0, "texto": "factura", "forma": "erd-tabla",
                        "columnas": [
                            { "nombre": "id", "tipo": "int", "pk": true },
                            { "nombre": "cliente_id", "tipo": "varchar(60)", "fk": true }
                        ]
                    }],
                    "conexiones": []
                }}
            }]
        });

        let mut texto = String::new();
        extraer_texto(&doc, &mut texto);

        assert!(texto.contains("factura"), "el nombre de la tabla; salió «{texto}»");
        assert!(texto.contains("cliente_id"), "el nombre de la columna; salió «{texto}»");
        // El tipo no: saldría en casi todas las tablas y no distingue ninguna.
        assert!(!texto.contains("varchar"), "los tipos no se indexan; salió «{texto}»");
    }

    /// Una tabla con las columnas rotas es exactamente igual de probable que un
    /// esquema roto, y corre en el mismo sitio: al guardar cada nota.
    #[test]
    fn una_tabla_con_columnas_raras_no_rompe_el_indexado() {
        for columnas in [json!(null), json!("id, nombre"), json!([null, 7, { "nombre": 3 }])] {
            let doc = json!({
                "type": "doc",
                "content": [{
                    "type": "esquema",
                    "attrs": { "datos": {
                        "nodos": [{ "id": "t", "texto": "factura", "columnas": columnas }],
                        "conexiones": []
                    }}
                }]
            });

            let mut texto = String::new();
            extraer_texto(&doc, &mut texto);
            assert!(texto.contains("factura"), "el nombre se sigue indexando");
        }
    }

    /// Un esquema a medio hacer o venido de otra versión no puede tumbar el
    /// indexado, que corre al guardar **cada** nota.
    #[test]
    fn un_esquema_con_datos_raros_no_rompe_el_indexado() {
        for datos in [json!(null), json!("vaya"), json!({ "nodos": "no es una lista" })] {
            let doc = json!({
                "type": "doc",
                "content": [{ "type": "esquema", "attrs": { "datos": datos } }]
            });

            let mut texto = String::new();
            extraer_texto(&doc, &mut texto);
            assert!(texto.trim().is_empty());
        }
    }

    /// La prueba de que el nodo encaja con el indexador de verdad: `attrs` es
    /// territorio que la regla general (claves `text`) no pisa.
    #[test]
    fn un_documento_con_diagrama_indexa_sus_etiquetas() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Arquitectura" }] },
                {
                    "type": "diagrama",
                    "attrs": { "formato": "mermaid", "codigo": "graph TD\nA[Pasarela de pago]" }
                }
            ]
        });

        let mut texto = String::new();
        extraer_texto(&doc, &mut texto);

        assert!(texto.contains("Arquitectura"), "el párrafo normal sigue igual");
        assert!(texto.contains("Pasarela de pago"), "salió «{texto}»");
        assert!(!texto.contains("graph"), "sin sintaxis; salió «{texto}»");
    }
}
