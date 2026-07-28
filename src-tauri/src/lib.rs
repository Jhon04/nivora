mod almacen;
mod commands;
mod db;
mod models;

use std::fs;

use tauri::Manager;

use almacen::Almacen;
use db::Db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Estructura del workspace:
            //   <app_data_dir>/Workspace/
            //       notas/<id>.json   ← las notas: fuente de verdad
            //       assets/           ← imágenes, con nombre de hash
            //       workspace.db      ← índice derivado (no se sincroniza)
            //       backups/  export/
            let base = app
                .path()
                .app_data_dir()
                .expect("no se pudo resolver app_data_dir");
            let workspace = base.join("Workspace");
            for sub in ["notas", "assets", "backups", "export"] {
                fs::create_dir_all(workspace.join(sub))?;
            }

            let db = Db::abrir(&workspace.join("workspace.db"))
                .expect("no se pudo abrir workspace.db");
            let almacen = Almacen::nuevo(&workspace.join("notas"))
                .expect("no se pudo abrir notas/");

            // Para que la carpeta se pueda meter en git tal cual.
            if let Err(e) = almacen::escribir_gitignore(&workspace) {
                log::warn!("no se pudo escribir .gitignore: {e}");
            }

            // El orden importa: primero se vuelcan a fichero las notas que solo
            // vivían en la BD (workspaces anteriores a este cambio) y DESPUÉS se
            // reconstruye el índice desde los ficheros. Al revés, la
            // reconstrucción vaciaría las tablas antes de haberlas salvado.
            almacen
                .migrar_desde_db(&db)
                .expect("no se pudieron migrar las notas de workspace.db");
            let n = almacen
                .reconstruir(&db)
                .expect("no se pudo reconstruir el índice desde notas/");
            if let Err(e) = db.reconstruir_assets(&workspace.join("assets")) {
                log::warn!("no se pudo reindexar assets/: {e}");
            }

            app.manage(db);
            app.manage(almacen);

            log::info!("Workspace listo en {} ({n} notas)", workspace.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::guardar_documento,
            commands::obtener_documento,
            commands::listar_documentos,
            commands::eliminar_documento,
            commands::recargar_workspace,
            commands::buscar_documentos,
            commands::listar_etiquetas,
            commands::guardar_asset,
            commands::importar_asset,
            commands::leer_imagen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
