use serde::{Deserialize, Serialize};
use serde_json::Value;

fn contenido_vacio() -> Value {
    Value::Array(vec![])
}

/// Documento completo. `contenido` son los bloques del editor (BlockNote / Tiptap)
/// tal cual, en JSON. En Rust viajan como `serde_json::Value` y se guardan como
/// TEXT en SQLite sin transformarlos.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Documento {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub titulo: String,
    #[serde(default)]
    pub icono: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Nota **bloqueada**: solo el dueño de la bóveda puede cambiarla o
    /// borrarla; los colaboradores la leen y nada más.
    ///
    /// Es una barandilla, no un permiso: quien tiene acceso de escritura al
    /// repositorio puede editar el fichero fuera de la app. Lo que la hace
    /// sólida es que la app del dueño **restaura** su versión al sincronizar si
    /// alguien la ha cambiado (ver `Almacen::restaurar_bloqueadas`).
    #[serde(default)]
    pub bloqueada: bool,
    #[serde(default = "contenido_vacio")]
    pub contenido: Value,
    #[serde(default)]
    pub creado: Option<String>,
    #[serde(default)]
    pub modificado: Option<String>,
}

/// Versión ligera para listados (barra lateral, búsquedas): sin el contenido.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentoResumen {
    pub id: String,
    pub titulo: String,
    pub icono: Option<String>,
    pub modificado: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Para pintar el candado en la lista sin abrir la nota.
    #[serde(default)]
    pub bloqueada: bool,
}

/// Etiqueta con su número de usos (para el autocompletado y el filtro).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagInfo {
    pub nombre: String,
    pub usos: i64,
}

/// Fila de un resultado de búsqueda (FTS5). Tanto `titulo` (completo, vía
/// `highlight()`) como `fragmento` (extracto del texto, vía `snippet()`) traen
/// los términos encontrados marcados con los caracteres de control U+0002
/// (inicio) y U+0003 (fin), que el frontend convierte en resaltado.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultadoBusqueda {
    pub id: String,
    pub titulo: String,
    pub icono: Option<String>,
    pub fragmento: String,
    pub modificado: String,
}

/// Imagen del disco leída en crudo, para editarla en el webview ANTES de
/// guardarla como asset. `datos` son los bytes del fichero en base64 y `ext` su
/// extensión en minúsculas (sin punto).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagenLeida {
    pub datos: String,
    pub ext: String,
}

/// Resultado de guardar un asset. `nombre` es el nombre relativo del fichero
/// (lo que se guarda en el documento); `ruta` es la ruta absoluta en disco;
/// `preview` es el nombre de la miniatura ligera (None si no se generó: imagen
/// ya pequeña, SVG, o formato no rasterizable).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetGuardado {
    pub id: String,
    pub nombre: String,
    pub ruta: String,
    pub preview: Option<String>,
}
