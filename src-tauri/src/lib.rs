mod almacen;
mod bovedas;
mod commands;
mod db;
mod escritorio;
mod github;
mod models;
mod secretos;
mod sincro;

use tauri::Manager;

use bovedas::Bovedas;
use github::Sesion;
use secretos::Secretos;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // `process` es lo que permite reiniciar la app sola tras instalar una
        // actualización; sin él el usuario tendría que cerrarla y abrirla a mano.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // El updater solo existe en escritorio: en móvil actualiza la tienda.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Si venimos de un AppImage, dejarse ver en el menú de aplicaciones.
            // No hace nada en los demás formatos ni en desarrollo.
            #[cfg(desktop)]
            escritorio::integrar(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Cada bóveda es una carpeta autónoma:
            //   <boveda>/
            //       notas/<id>.json   ← las notas: fuente de verdad
            //       assets/           ← imágenes, con nombre de hash
            //       workspace.db      ← índice derivado (no se sincroniza)
            //       .git/             ← SU repositorio remoto
            //       backups/  export/
            //
            // El registro de bóvedas y la apertura de la activa viven en
            // `bovedas.rs`, porque cambiar de bóveda repite exactamente esta
            // misma secuencia y no puede estar solo aquí.
            let base = app
                .path()
                .app_data_dir()
                .expect("no se pudo resolver app_data_dir");
            let bovedas = Bovedas::iniciar(&base).expect("no se pudo abrir la bóveda");
            log::info!("bóveda activa: {}", bovedas.activa().nombre);
            app.manage(bovedas);

            // Sesión de GitHub: el token vive en el llavero, aquí solo queda el
            // device flow a medias y el usuario en memoria.
            app.manage(Sesion::default());
            // Clave de los bloques cifrados: solo en memoria y solo un rato.
            app.manage(Secretos::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::guardar_documento,
            commands::obtener_documento,
            commands::listar_documentos,
            commands::eliminar_documento,
            commands::recargar_workspace,
            commands::listar_bovedas,
            commands::boveda_activa,
            commands::crear_boveda,
            commands::cambiar_boveda,
            commands::olvidar_boveda,
            commands::renombrar_boveda,
            commands::estado_secretos,
            commands::configurar_secretos,
            commands::desbloquear_secretos,
            commands::bloquear_secretos,
            commands::cifrar_secreto,
            commands::descifrar_secreto,
            commands::rotar_clave_maestra,
            commands::comprobar_acceso,
            commands::github_sesion,
            commands::github_iniciar_sesion,
            commands::github_esperar_aprobacion,
            commands::github_cerrar_sesion,
            commands::github_estado_client_id,
            commands::github_fijar_client_id,
            commands::github_listar_repos,
            commands::crear_repo,
            commands::conectar_repo,
            commands::sincronizar,
            commands::estado_sincro,
            commands::desconectar_repo,
            commands::buscar_documentos,
            commands::listar_etiquetas,
            commands::guardar_asset,
            commands::importar_asset,
            commands::leer_imagen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
