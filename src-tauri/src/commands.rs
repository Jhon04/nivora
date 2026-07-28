use std::fs;
use std::path::Path;

use base64::{engine::general_purpose, Engine};
use image::GenericImageView;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::almacen::Almacen;
use crate::db::Db;
use crate::models::{
    AssetGuardado, Documento, DocumentoResumen, ImagenLeida, ResultadoBusqueda, TagInfo,
};

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

/// Escribe `notas/<id>.json` y actualiza el índice.
/// Angular: `invoke('guardar_documento', { documento })`
#[tauri::command]
pub fn guardar_documento(
    db: State<'_, Db>,
    almacen: State<'_, Almacen>,
    documento: Documento,
) -> Result<Documento, String> {
    almacen.guardar(&db, documento)
}

/// Lee la nota del **fichero**, no del índice: es la fuente de verdad, así que
/// abrir un documento devuelve lo que hay en disco aunque el índice se haya
/// quedado atrás (por ejemplo si acaban de llegar cambios de otro equipo).
/// Angular: `invoke('obtener_documento', { id })`
#[tauri::command]
pub fn obtener_documento(
    almacen: State<'_, Almacen>,
    id: String,
) -> Result<Option<Documento>, String> {
    almacen.leer(&id)
}

/// Angular: `invoke('listar_documentos')`
#[tauri::command]
pub fn listar_documentos(db: State<'_, Db>) -> Result<Vec<DocumentoResumen>, String> {
    db.listar()
}

/// Angular: `invoke('eliminar_documento', { id })`
#[tauri::command]
pub fn eliminar_documento(
    db: State<'_, Db>,
    almacen: State<'_, Almacen>,
    id: String,
) -> Result<(), String> {
    almacen.eliminar(&db, &id)
}

/// Relee `notas/` y rehace el índice. Es lo que hay que llamar tras traer
/// cambios de otro equipo (`git pull`, Syncthing) sin cerrar la app. Devuelve
/// cuántas notas hay ahora en el workspace.
/// Angular: `invoke('recargar_workspace')`
#[tauri::command]
pub fn recargar_workspace(
    app: AppHandle,
    db: State<'_, Db>,
    almacen: State<'_, Almacen>,
) -> Result<usize, String> {
    let n = almacen.reconstruir(&db)?;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    db.reconstruir_assets(&base.join("Workspace").join("assets"))?;
    Ok(n)
}

/// Búsqueda de texto completo (FTS5).
/// Angular: `invoke('buscar_documentos', { consulta })`
#[tauri::command]
pub fn buscar_documentos(
    db: State<'_, Db>,
    consulta: String,
) -> Result<Vec<ResultadoBusqueda>, String> {
    db.buscar(&consulta)
}

/// Todas las etiquetas con su número de usos.
/// Angular: `invoke('listar_etiquetas')`
#[tauri::command]
pub fn listar_etiquetas(db: State<'_, Db>) -> Result<Vec<TagInfo>, String> {
    db.listar_tags()
}

/// Lógica común: guarda `bytes` en `Workspace/assets/` con nombre por hash de
/// contenido, lo registra en la tabla `asset` y devuelve su ruta absoluta.
fn escribir_asset(app: &AppHandle, db: &Db, bytes: &[u8], ext: &str) -> Result<AssetGuardado, String> {
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

    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("Workspace").join("assets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let ruta = dir.join(&nombre);
    if !ruta.exists() {
        fs::write(&ruta, bytes).map_err(|e| e.to_string())?;
    }

    let id = db.guardar_asset(&ext, &nombre, &hash)?;
    let preview = generar_preview(&dir, &hash, bytes, &ext);

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
    app: AppHandle,
    db: State<'_, Db>,
    datos_base64: String,
    ext: String,
) -> Result<AssetGuardado, String> {
    let bytes = general_purpose::STANDARD
        .decode(datos_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    escribir_asset(&app, db.inner(), &bytes, &ext)
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
    app: AppHandle,
    db: State<'_, Db>,
    ruta: String,
) -> Result<AssetGuardado, String> {
    let bytes = fs::read(&ruta).map_err(|e| format!("No se pudo leer {ruta}: {e}"))?;
    let ext = Path::new(&ruta)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    escribir_asset(&app, db.inner(), &bytes, ext)
}
