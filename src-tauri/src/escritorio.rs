//! Integración con el escritorio cuando la app corre como AppImage.
//!
//! Un AppImage es un fichero suelto: no instala nada, así que no aparece en el
//! menú de aplicaciones ni en la búsqueda. El `.deb` sí se integra (dpkg copia
//! el `.desktop` y los iconos a `/usr/share`), pero el `.deb` no se
//! auto-actualiza. Es decir, el formato que se actualiza solo es justo el que
//! no se ve por ningún lado.
//!
//! Aquí se cierra ese hueco: al arrancar desde un AppImage, la app escribe su
//! propia entrada en `~/.local/share/applications` y sus iconos en
//! `~/.local/share/icons`. Todo en el directorio del usuario, sin root.
//!
//! Nada de esto puede tumbar el arranque: si algo falla se registra y la app
//! sigue. Es una comodidad, no un requisito para funcionar.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Iconos empotrados en el binario. No se pueden leer del AppImage montado
/// porque su punto de montaje desaparece al cerrar la app, y la entrada del
/// menú tiene que seguir funcionando después.
const ICONOS: &[(&str, &[u8])] = &[
    ("32x32", include_bytes!("../icons/32x32.png")),
    ("128x128", include_bytes!("../icons/128x128.png")),
    ("256x256", include_bytes!("../icons/128x128@2x.png")),
    ("512x512", include_bytes!("../icons/icon.png")),
];

/// Nombre base del icono y del `.desktop`. Es el que va en `Icon=`.
const NOMBRE: &str = "nivora";

/// Integra la app con el escritorio si corre como AppImage.
///
/// Fuera de AppImage no hace nada: en `.deb` ya se encarga dpkg, y en
/// desarrollo no queremos ensuciar el menú del usuario con builds de prueba.
pub fn integrar(app: &AppHandle) {
    // `APPIMAGE` la exporta el propio runtime del AppImage y trae la ruta
    // absoluta del fichero. Es la unica forma fiable de saber que estamos
    // dentro de uno: el binario no puede averiguarlo por si mismo.
    let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        return;
    };

    let Ok(datos) = app.path().data_dir() else {
        log::warn!("no se pudo resolver el directorio de datos; sin integracion de escritorio");
        return;
    };

    match escribir(&datos, &appimage) {
        Ok(true) => {
            log::info!("integracion de escritorio actualizada para {}", appimage.display());
            refrescar_indice(&datos);
        }
        Ok(false) => log::debug!("integracion de escritorio ya al dia"),
        Err(e) => log::warn!("no se pudo integrar con el escritorio: {e}"),
    }
}

/// Escribe iconos y `.desktop`. Devuelve `true` si algo cambió de verdad.
fn escribir(datos: &Path, appimage: &Path) -> std::io::Result<bool> {
    let mut cambios = false;

    for (tamano, bytes) in ICONOS {
        let dir = datos.join("icons/hicolor").join(tamano).join("apps");
        fs::create_dir_all(&dir)?;
        cambios |= escribir_si_cambia(&dir.join(format!("{NOMBRE}.png")), bytes)?;
    }

    let dir = datos.join("applications");
    fs::create_dir_all(&dir)?;
    let entrada = plantilla(appimage);
    cambios |= escribir_si_cambia(&dir.join(format!("{NOMBRE}.desktop")), entrada.as_bytes())?;

    Ok(cambios)
}

/// Solo toca el disco si el contenido difiere.
///
/// Esto corre en cada arranque, y reescribir cinco ficheros cada vez seria
/// gratuito solo en apariencia: cambiar la fecha del `.desktop` hace que el
/// escritorio reindexe el menu sin motivo.
fn escribir_si_cambia(ruta: &Path, contenido: &[u8]) -> std::io::Result<bool> {
    if fs::read(ruta).is_ok_and(|actual| actual == contenido) {
        return Ok(false);
    }
    fs::write(ruta, contenido)?;
    Ok(true)
}

/// El `.desktop`, con `Exec` apuntando a donde este el AppImage AHORA.
///
/// Se regenera en cada arranque a proposito: si el usuario mueve el fichero,
/// la comparacion de contenido detecta el cambio y la entrada se corrige sola.
fn plantilla(appimage: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Nivora\n\
         GenericName=Editor de notas\n\
         Comment=Notas locales con bóvedas y sincronización por GitHub\n\
         Exec={} %U\n\
         Icon={NOMBRE}\n\
         Terminal=false\n\
         Categories=Office;TextEditor;\n\
         Keywords=notas;notes;markdown;editor;boveda;bóveda;nivora;\n\
         StartupNotify=true\n\
         StartupWMClass=app\n",
        exec_escapado(appimage)
    )
}

/// Cita la ruta si lleva caracteres que el estandar de `.desktop` reserva.
///
/// Sin esto, un AppImage en «~/Mis Programas/» partiria `Exec` en dos y el
/// lanzador no arrancaria nada.
fn exec_escapado(ruta: &Path) -> String {
    let s = ruta.to_string_lossy();
    if !s.contains(|c: char| c.is_whitespace() || "\"'\\><~|&;$*?#()`".contains(c)) {
        return s.into_owned();
    }
    // Dentro de comillas hay que escapar la barra invertida, las comillas, el
    // acento grave y el dolar: es lo que el estandar considera reservado.
    let mut escapado = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        if matches!(c, '\\' | '"' | '`' | '$') {
            escapado.push('\\');
        }
        escapado.push(c);
    }
    format!("\"{escapado}\"")
}

/// Pide al escritorio que reindexe. Es opcional: sin esto la entrada aparece
/// igual, solo que puede tardar (o pedir cerrar sesion) segun el entorno.
fn refrescar_indice(datos: &Path) {
    let _ = std::process::Command::new("update-desktop-database")
        .arg(datos.join("applications"))
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporal() -> PathBuf {
        let d = std::env::temp_dir().join(format!("escritorio-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn una_ruta_normal_no_se_cita() {
        let e = exec_escapado(Path::new("/home/ivan/Apps/Nivora.AppImage"));
        assert_eq!(e, "/home/ivan/Apps/Nivora.AppImage");
    }

    #[test]
    fn una_ruta_con_espacios_se_cita() {
        // Sin comillas, el lanzador leeria «/home/ivan/Mis» como el ejecutable
        // y «Programas/Nivora.AppImage» como un argumento suelto.
        let e = exec_escapado(Path::new("/home/ivan/Mis Programas/Nivora.AppImage"));
        assert_eq!(e, "\"/home/ivan/Mis Programas/Nivora.AppImage\"");
    }

    #[test]
    fn los_caracteres_reservados_se_escapan() {
        let e = exec_escapado(Path::new("/home/a b/x$y`z\"w.AppImage"));
        assert_eq!(e, "\"/home/a b/x\\$y\\`z\\\"w.AppImage\"");
    }

    #[test]
    fn la_entrada_apunta_al_appimage() {
        let d = plantilla(Path::new("/opt/Nivora.AppImage"));
        assert!(d.contains("Exec=/opt/Nivora.AppImage %U"));
        assert!(d.contains("Icon=nivora"));
        // Sin Type y Name la entrada es invalida y el menu la ignora.
        assert!(d.contains("Type=Application"));
        assert!(d.contains("Name=Nivora"));
    }

    #[test]
    fn no_reescribe_si_no_cambia_nada() {
        let d = temporal();
        let f = d.join("prueba");

        assert!(escribir_si_cambia(&f, b"uno").unwrap(), "la primera vez escribe");
        assert!(!escribir_si_cambia(&f, b"uno").unwrap(), "el mismo contenido no toca el disco");
        assert!(escribir_si_cambia(&f, b"dos").unwrap(), "un cambio si se escribe");
        assert_eq!(fs::read(&f).unwrap(), b"dos");
    }

    #[test]
    fn mover_el_appimage_corrige_la_entrada() {
        let datos = temporal();
        let antes = Path::new("/home/ivan/Nivora.AppImage");
        let despues = Path::new("/home/ivan/Apps/Nivora.AppImage");

        assert!(escribir(&datos, antes).unwrap());
        assert!(!escribir(&datos, antes).unwrap(), "sin cambios, no se reescribe");

        // Al mover el fichero, el siguiente arranque tiene que arreglar `Exec`
        // solo: si no, la entrada del menu se queda apuntando a la nada.
        assert!(escribir(&datos, despues).unwrap());
        let entrada = fs::read_to_string(datos.join("applications/nivora.desktop")).unwrap();
        assert!(entrada.contains("Exec=/home/ivan/Apps/Nivora.AppImage %U"));
    }

    #[test]
    fn escribe_los_iconos_en_el_arbol_hicolor() {
        let datos = temporal();
        escribir(&datos, Path::new("/opt/Nivora.AppImage")).unwrap();

        for (tamano, bytes) in ICONOS {
            let icono = datos
                .join("icons/hicolor")
                .join(tamano)
                .join("apps/nivora.png");
            assert_eq!(&fs::read(&icono).unwrap(), bytes, "icono {tamano}");
        }
    }
}
