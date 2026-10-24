//! Exportar la nota abierta a PDF.
//!
//! El PDF es la nota **tal como se ve**: se imprime el propio webview, y el
//! `@media print` de `styles.scss` deja solo la nota (sin barra lateral ni
//! herramientas). No hay un segundo motor de dibujo que se pueda desfasar del
//! editor.
//!
//! Por qué no `window.print()`: abre el diálogo de impresión de GTK, donde hay
//! que elegir «Imprimir a archivo», el formato y la ruta a mano. Aquí se imprime
//! **sin diálogo**, directamente a la ruta que el usuario ya eligió en
//! «Guardar como…».
//!
//! La impresora es la virtual de GTK «Imprimir a archivo». Su nombre viene
//! traducido según el idioma del escritorio, así que se pide a gettext en vez
//! de escribirlo a mano; si no hay traducción, gettext devuelve el original.

/// Angular: `invoke('exportar_pdf', { ruta })`
#[tauri::command]
pub async fn exportar_pdf(webview: tauri::Webview, ruta: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux::exportar(&webview, ruta).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (webview, ruta);
        Err("Exportar a PDF solo está disponible en Linux por ahora.".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gtk::glib;
    use tokio::sync::oneshot;
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    type Respuesta = oneshot::Sender<Result<(), String>>;

    pub async fn exportar(webview: &tauri::Webview, ruta: String) -> Result<(), String> {
        let uri = glib::filename_to_uri(&ruta, None)
            .map_err(|e| format!("Ruta no válida {ruta}: {e}"))?
            .to_string();
        let (tx, rx) = oneshot::channel();

        // GTK solo se toca desde el hilo principal: with_webview lleva allí el cierre.
        webview
            .with_webview(move |plataforma| imprimir(&plataforma.inner(), &uri, tx))
            .map_err(|e| format!("No se pudo acceder a la vista: {e}"))?;

        rx.await
            .map_err(|_| "La impresión terminó sin dar respuesta.".to_string())?
    }

    fn imprimir(vista: &webkit2gtk::WebView, uri: &str, tx: Respuesta) {
        let ajustes = gtk::PrintSettings::new();
        ajustes.set_printer(&glib::dgettext(Some("gtk30"), "Print to File"));
        ajustes.set("output-file-format", Some("pdf"));
        ajustes.set("output-uri", Some(uri));

        let pagina = gtk::PageSetup::new();
        pagina.set_paper_size_and_default_margins(&gtk::PaperSize::new(Some(
            gtk::PAPER_NAME_A4,
        )));

        let op = PrintOperation::new(vista);
        op.set_print_settings(&ajustes);
        op.set_page_setup(&pagina);

        // `failed` llega antes que `finished` (que se emite siempre): el primero
        // que responde se queda el canal. La operación se guarda junto al canal
        // para que siga viva hasta terminar, y se suelta al responder.
        let pendiente = Rc::new(RefCell::new(Some((tx, op.clone()))));

        let p = pendiente.clone();
        op.connect_failed(move |_, err| {
            if let Some((tx, _)) = p.borrow_mut().take() {
                let _ = tx.send(Err(format!("No se pudo generar el PDF: {err}")));
            }
        });
        op.connect_finished(move |_| {
            if let Some((tx, _)) = pendiente.borrow_mut().take() {
                let _ = tx.send(Ok(()));
            }
        });

        op.print();
    }
}
