//! Bloques cifrados dentro de una nota.
//!
//! No se cifra la bóveda ni la nota entera —eso rompía los diffs de git, la
//! fusión por fecha y la deduplicación de imágenes— sino **solo el valor de los
//! bloques `secreto`**: contraseñas, cadenas de conexión, credenciales. El resto
//! de la nota sigue siendo JSON legible y todo lo demás sigue funcionando igual.
//!
//! # El texto en claro no entra nunca en el documento
//!
//! Es la regla que decide el diseño. Si el bloque fuera texto normal y se
//! cifrara "al guardar", el autoguardado ya habría escrito la contraseña en
//! claro en disco y en un commit — y git no olvida. Por eso el bloque es un
//! *atom*: se cifra aquí, y en el JSON de la nota solo existe el resultado.
//!
//! Como el cifrado viaja en los `attrs` del nodo y no en un nodo de texto,
//! `db::extraer_texto` no lo ve: el índice FTS **nunca** contiene el secreto.
//!
//! # La clave
//!
//! Se deriva de una contraseña maestra con Argon2id. Tiene que ser así y no una
//! clave aleatoria en el llavero: la misma bóveda se abre en varios equipos y la
//! clave no puede viajar en el repositorio. La **sal** sí se guarda en la bóveda
//! (las sales no son secretas) junto a un verificador, que permite distinguir
//! «contraseña incorrecta» de «dato corrupto».

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};

use crate::models::Documento;

/// Fichero de configuración dentro de la bóveda. Se versiona en git: el segundo
/// equipo necesita la misma sal para derivar la misma clave.
const FICHERO: &str = "secretos.json";

/// Prefijo de formato. Va delante para poder cambiar de algoritmo algún día sin
/// dejar de leer lo antiguo.
const VERSION: &str = "v1";

/// Texto conocido que se cifra al configurar. Descifrarlo bien es la prueba de
/// que la contraseña es correcta.
const TESTIGO: &[u8] = b"nivora::secretos";

/// Tiempo sin usar tras el cual la clave se borra de memoria.
const INACTIVIDAD: Duration = Duration::from_secs(5 * 60);

/// Longitud mínima de la contraseña maestra.
///
/// La sal y el verificador viajan en el repositorio, así que quien pueda leerlo
/// puede **probar contraseñas sin conexión, a su ritmo**. Argon2id encarece cada
/// intento (~50-100 ms con los parámetros por defecto, los recomendados por
/// OWASP), pero eso solo compra tiempo: lo que protege de verdad es la longitud.
pub const MINIMO: usize = 12;

fn validar_contrasena(c: &str) -> Result<(), String> {
    if c.chars().count() < MINIMO {
        return Err(format!(
            "la contraseña maestra necesita al menos {MINIMO} caracteres; \
             una frase de varias palabras va mejor que una palabra rara"
        ));
    }
    Ok(())
}

/// Configuración de cifrado de la bóveda.
///
/// **Se describe a sí misma a propósito.** El algoritmo no es un secreto —toda
/// la seguridad está en la contraseña, nunca en que nadie sepa qué se usa— y en
/// cambio dentro de unos años, sin la app delante, un `version: 1` a secas no le
/// diría nada a nadie. Estos campos son la diferencia entre poder recuperar tus
/// credenciales con 60 líneas y no poder recuperarlas.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Config {
    version: u8,
    /// Sal de Argon2id, en base64. No es secreta.
    sal: String,
    /// `TESTIGO` cifrado con la clave derivada.
    verificador: String,

    // --- Cómo descifrar esto sin la app (ver `herramientas/recuperar`) ---
    #[serde(default = "kdf_por_defecto")]
    kdf: String,
    #[serde(default = "parametros_por_defecto")]
    kdf_parametros: String,
    #[serde(default = "cifrado_por_defecto")]
    cifrado: String,
    #[serde(default = "formato_por_defecto")]
    formato: String,
    #[serde(default = "testigo_por_defecto")]
    testigo: String,
}

fn kdf_por_defecto() -> String {
    "argon2id".into()
}
fn parametros_por_defecto() -> String {
    "m=19456KiB, t=2, p=1, salida=32 bytes".into()
}
fn cifrado_por_defecto() -> String {
    "xchacha20poly1305".into()
}
fn formato_por_defecto() -> String {
    "\"v1.\" + base64(nonce[24] || sellado)".into()
}
fn testigo_por_defecto() -> String {
    String::from_utf8_lossy(TESTIGO).into_owned()
}

impl Config {
    fn nueva(sal: &[u8], verificador: String) -> Self {
        Self {
            version: 1,
            sal: STANDARD.encode(sal),
            verificador,
            kdf: kdf_por_defecto(),
            kdf_parametros: parametros_por_defecto(),
            cifrado: cifrado_por_defecto(),
            formato: formato_por_defecto(),
            testigo: testigo_por_defecto(),
        }
    }
}

/// Lo que la interfaz necesita saber para pintar el candado.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EstadoSecretos {
    /// ¿Esta bóveda ya tiene contraseña maestra?
    pub configurado: bool,
    /// ¿Está la clave en memoria ahora mismo?
    pub desbloqueado: bool,
}

/// Clave derivada, viva solo en memoria y solo un rato.
struct Abierta {
    clave: [u8; 32],
    /// Para cerrar solo tras un rato sin usarla.
    ultimo_uso: Instant,
}

/// Estado de Tauri. La clave **no sale de aquí**: el webview recibe el texto en
/// claro cuando lo pide, pero nunca la clave, igual que con el token de GitHub.
#[derive(Default)]
pub struct Secretos(Mutex<Option<Abierta>>);

fn ruta_config(boveda: &Path) -> PathBuf {
    boveda.join(FICHERO)
}

fn leer_config(boveda: &Path) -> Option<Config> {
    let crudo = std::fs::read_to_string(ruta_config(boveda)).ok()?;
    let config: Config = serde_json::from_str(&crudo).ok()?;

    // Bóvedas creadas antes de que el fichero se describiera solo: los campos
    // llegan por `serde(default)`, así que basta con reescribirlo para que
    // queden anotados. Un `version: 1` a secas no le sirve a nadie dentro de
    // unos años.
    if !crudo.contains("\"kdf\"") {
        let _ = escribir_config(boveda, &config);
    }
    Some(config)
}

fn escribir_config(boveda: &Path, config: &Config) -> Result<(), String> {
    std::fs::write(
        ruta_config(boveda),
        serde_json::to_string_pretty(config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Deriva la clave con Argon2id. Los parámetros por defecto del crate son los
/// recomendados por OWASP; no se bajan para "ir más rápido" porque el coste es
/// justo lo que protege una contraseña corta.
fn derivar(contrasena: &str, sal: &[u8]) -> Result<[u8; 32], String> {
    let mut clave = [0u8; 32];
    Argon2::default()
        .hash_password_into(contrasena.as_bytes(), sal, &mut clave)
        .map_err(|e| format!("no se pudo derivar la clave: {e}"))?;
    Ok(clave)
}

fn cifrar_con(clave: &[u8; 32], claro: &[u8]) -> Result<String, String> {
    let cifrador = XChaCha20Poly1305::new(clave.into());
    // Nonce aleatorio por bloque: cifrar dos veces el mismo valor da resultados
    // distintos, así que no se puede saber que dos secretos son iguales.
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sellado = cifrador
        .encrypt(&nonce, claro)
        .map_err(|_| "no se pudo cifrar".to_string())?;

    let mut bytes = nonce.to_vec();
    bytes.extend_from_slice(&sellado);
    Ok(format!("{VERSION}.{}", STANDARD.encode(bytes)))
}

fn descifrar_con(clave: &[u8; 32], datos: &str) -> Result<Vec<u8>, String> {
    let cuerpo = datos
        .strip_prefix(&format!("{VERSION}."))
        .ok_or("el bloque cifrado tiene un formato que esta versión no entiende")?;
    let bytes = STANDARD
        .decode(cuerpo)
        .map_err(|_| "el bloque cifrado está corrupto".to_string())?;
    if bytes.len() <= 24 {
        return Err("el bloque cifrado está incompleto".into());
    }
    let (nonce, sellado) = bytes.split_at(24);

    XChaCha20Poly1305::new(clave.into())
        .decrypt(XNonce::from_slice(nonce), sellado)
        // El fallo puede ser contraseña incorrecta o dato manipulado; no se
        // puede distinguir, y tampoco conviene decir cuál.
        .map_err(|_| "no se pudo descifrar: ¿contraseña incorrecta?".to_string())
}

impl Secretos {
    /// Clave viva, si la hay. Cierra sola tras `INACTIVIDAD` y refresca el reloj
    /// en cada uso legítimo.
    fn clave(&self) -> Result<[u8; 32], String> {
        let mut guardia = self.0.lock().map_err(|e| e.to_string())?;
        let Some(abierta) = guardia.as_mut() else {
            return Err("los secretos están bloqueados".into());
        };
        if abierta.ultimo_uso.elapsed() > INACTIVIDAD {
            *guardia = None;
            return Err("los secretos se han bloqueado por inactividad".into());
        }
        abierta.ultimo_uso = Instant::now();
        Ok(abierta.clave)
    }

    pub fn estado(&self, boveda: &Path) -> EstadoSecretos {
        // Se consulta la clave (y no el `Option` a pelo) para que el estado
        // refleje el cierre por inactividad y no diga "desbloqueado" de más.
        EstadoSecretos {
            configurado: leer_config(boveda).is_some(),
            desbloqueado: self.clave().is_ok(),
        }
    }

    /// Primera vez en esta bóveda: genera la sal, deriva y guarda el verificador.
    pub fn configurar(&self, boveda: &Path, contrasena: &str) -> Result<(), String> {
        validar_contrasena(contrasena)?;
        if leer_config(boveda).is_some() {
            return Err("esta bóveda ya tiene contraseña maestra".into());
        }

        let sal: [u8; 16] = rand_bytes();
        let clave = derivar(contrasena, &sal)?;
        escribir_config(boveda, &Config::nueva(&sal, cifrar_con(&clave, TESTIGO)?))?;

        *self.0.lock().map_err(|e| e.to_string())? =
            Some(Abierta { clave, ultimo_uso: Instant::now() });
        Ok(())
    }

    /// Deriva y **comprueba** la clave contra el verificador, sin instalarla.
    fn clave_de(&self, boveda: &Path, contrasena: &str) -> Result<[u8; 32], String> {
        let config = leer_config(boveda)
            .ok_or("esta bóveda todavía no tiene contraseña maestra")?;
        let sal = STANDARD
            .decode(&config.sal)
            .map_err(|_| "la configuración de secretos está corrupta".to_string())?;
        let clave = derivar(contrasena, &sal)?;

        // Sin esto, una contraseña incorrecta no se detectaría hasta intentar
        // descifrar un bloque, y el error saldría en el sitio equivocado.
        if descifrar_con(&clave, &config.verificador)? != TESTIGO {
            return Err("contraseña incorrecta".into());
        }
        Ok(clave)
    }

    /// Comprueba la contraseña contra el verificador y deja la clave en memoria.
    pub fn desbloquear(&self, boveda: &Path, contrasena: &str) -> Result<(), String> {
        let clave = self.clave_de(boveda, contrasena)?;
        *self.0.lock().map_err(|e| e.to_string())? =
            Some(Abierta { clave, ultimo_uso: Instant::now() });
        Ok(())
    }

    /// Cambia la contraseña maestra y **recifra todos los bloques** con la clave
    /// nueva. Devuelve las notas modificadas, para que quien llama las guarde.
    ///
    /// El orden es lo importante: se descifra **todo** primero y solo si no falla
    /// ni un bloque se escribe algo. Si se fuera guardando sobre la marcha y
    /// fallara a mitad, la bóveda quedaría con unos bloques cifrados con la clave
    /// vieja y otros con la nueva — es decir, rota sin arreglo.
    ///
    /// Sirve para cuando alguien deja el equipo, pero **no le quita lo que ya
    /// vio**, ni el clon del repositorio que pueda tener con el cifrado viejo.
    /// Lo que consigue es que lo que se guarde a partir de ahora quede fuera de
    /// su alcance; las credenciales de verdad hay que cambiarlas aparte.
    pub fn rotar(
        &self,
        boveda: &Path,
        actual: &str,
        nueva: &str,
        docs: &[Documento],
    ) -> Result<Vec<Documento>, String> {
        validar_contrasena(nueva)?;
        let vieja = self.clave_de(boveda, actual)?;

        let sal: [u8; 16] = rand_bytes();
        let clave = derivar(nueva, &sal)?;

        // Primero en memoria, y entero.
        let mut cambiadas = Vec::new();
        for doc in docs {
            let mut contenido = doc.contenido.clone();
            if recifrar(&mut contenido, &vieja, &clave)? > 0 {
                cambiadas.push(Documento { contenido, ..doc.clone() });
            }
        }

        // Todo descifró bien: ya se puede tocar el disco.
        escribir_config(boveda, &Config::nueva(&sal, cifrar_con(&clave, TESTIGO)?))?;

        *self.0.lock().map_err(|e| e.to_string())? =
            Some(Abierta { clave, ultimo_uso: Instant::now() });
        Ok(cambiadas)
    }

    pub fn bloquear(&self) {
        if let Ok(mut g) = self.0.lock() {
            *g = None;
        }
    }

    pub fn cifrar(&self, claro: &str) -> Result<String, String> {
        cifrar_con(&self.clave()?, claro.as_bytes())
    }

    pub fn descifrar(&self, datos: &str) -> Result<String, String> {
        let bytes = descifrar_con(&self.clave()?, datos)?;
        String::from_utf8(bytes).map_err(|_| "el secreto no es texto válido".to_string())
    }
}

/// Recorre el JSON de una nota y recifra los nodos `secreto`. Devuelve cuántos.
fn recifrar(
    valor: &mut serde_json::Value,
    vieja: &[u8; 32],
    nueva: &[u8; 32],
) -> Result<usize, String> {
    let mut n = 0;
    match valor {
        serde_json::Value::Object(mapa) => {
            if mapa.get("type").and_then(|t| t.as_str()) == Some("secreto") {
                if let Some(datos) = mapa
                    .get("attrs")
                    .and_then(|a| a.get("datos"))
                    .and_then(|d| d.as_str())
                    .map(String::from)
                {
                    let claro = descifrar_con(vieja, &datos)?;
                    let recifrado = cifrar_con(nueva, &claro)?;
                    if let Some(attrs) = mapa.get_mut("attrs").and_then(|a| a.as_object_mut()) {
                        attrs.insert("datos".into(), serde_json::Value::String(recifrado));
                        n += 1;
                    }
                }
            }
            for (_, v) in mapa.iter_mut() {
                n += recifrar(v, vieja, nueva)?;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                n += recifrar(item, vieja, nueva)?;
            }
        }
        _ => {}
    }
    Ok(n)
}

/// Bytes aleatorios del sistema.
fn rand_bytes<const N: usize>() -> [u8; N] {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temporal(PathBuf);

    impl Temporal {
        fn nueva() -> Self {
            let d = std::env::temp_dir().join(format!("secretos-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
    }

    impl Drop for Temporal {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const CLAVE_MAESTRA: &str = "correcta caballo batería grapa";
    const NUEVA: &str = "otra frase bastante larga";

    fn nota_con_secretos(cifrados: &[&str]) -> Documento {
        let bloques: Vec<serde_json::Value> = cifrados
            .iter()
            .map(|c| serde_json::json!({ "type": "secreto", "attrs": { "etiqueta": "x", "datos": c } }))
            .collect();
        Documento {
            id: Some("n1".into()),
            titulo: "Credenciales".into(),
            icono: None,
            cover: None,
            tags: vec![],
            bloqueada: false,
            // Uno suelto y el resto anidados, para comprobar que el recorrido
            // los encuentra a cualquier profundidad.
            contenido: serde_json::json!({
                "type": "doc",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "hola" }] },
                    bloques.first().cloned().unwrap_or(serde_json::Value::Null),
                    { "type": "bulletList", "content": bloques.get(1..).unwrap_or(&[]).to_vec() },
                ]
            }),
            creado: None,
            modificado: None,
        }
    }

    #[test]
    fn un_secreto_va_y_vuelve() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        let cifrado = s.cifrar("jdbc:mysql://localhost:3307/adcomp").unwrap();
        assert_eq!(s.descifrar(&cifrado).unwrap(), "jdbc:mysql://localhost:3307/adcomp");
    }

    #[test]
    fn el_texto_en_claro_no_aparece_en_lo_que_se_guarda() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        let cifrado = s.cifrar("pass12345").unwrap();

        // Esto es lo único que llega al JSON de la nota y al commit.
        assert!(!cifrado.contains("pass12345"), "{cifrado}");
        assert!(cifrado.starts_with("v1."));
        // Y la configuración que SÍ se versiona tampoco lo lleva.
        let config = std::fs::read_to_string(t.0.join(FICHERO)).unwrap();
        assert!(!config.contains("pass12345"));
        assert!(!config.contains(CLAVE_MAESTRA));
    }

    #[test]
    fn el_mismo_valor_cifrado_dos_veces_da_resultados_distintos() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        // Nonce aleatorio: si no, se podría saber que dos secretos son iguales
        // solo mirando el repositorio.
        assert_ne!(s.cifrar("misma").unwrap(), s.cifrar("misma").unwrap());
    }

    #[test]
    fn otro_equipo_lo_abre_con_la_misma_contrasena() {
        let t = Temporal::nueva();
        let cifrado = {
            let s = Secretos::default();
            s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
            s.cifrar("pedroRamires").unwrap()
        };

        // Segundo equipo: solo tiene la carpeta de la bóveda (con su sal) y la
        // contraseña que teclea el usuario.
        let otro = Secretos::default();
        otro.desbloquear(&t.0, CLAVE_MAESTRA).unwrap();
        assert_eq!(otro.descifrar(&cifrado).unwrap(), "pedroRamires");
    }

    #[test]
    fn una_contrasena_incorrecta_se_detecta_al_desbloquear() {
        let t = Temporal::nueva();
        Secretos::default().configurar(&t.0, CLAVE_MAESTRA).unwrap();

        let otro = Secretos::default();
        let e = otro.desbloquear(&t.0, "no es").unwrap_err();

        // Y se dice AQUÍ, no al abrir un bloque: si no, el error saldría en el
        // sitio equivocado y parecería que la nota está corrupta.
        assert!(e.contains("incorrecta"), "{e}");
        assert!(!otro.estado(&t.0).desbloqueado);
    }

    #[test]
    fn bloqueado_no_se_puede_ni_cifrar_ni_descifrar() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        let cifrado = s.cifrar("secreto").unwrap();

        s.bloquear();

        assert!(s.cifrar("otro").is_err());
        assert!(s.descifrar(&cifrado).is_err());
        assert!(!s.estado(&t.0).desbloqueado);
    }

    #[test]
    fn se_cierra_solo_tras_un_rato_sin_usarlo() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        // Se envejece el reloj a mano para no dormir en el test.
        {
            let mut g = s.0.lock().unwrap();
            let a = g.as_mut().unwrap();
            a.ultimo_uso = Instant::now() - INACTIVIDAD - Duration::from_secs(1);
        }

        let e = s.cifrar("tarde").unwrap_err();
        assert!(e.contains("inactividad"), "{e}");
        assert!(!s.estado(&t.0).desbloqueado, "y la clave ya no está en memoria");
    }

    #[test]
    fn usarlo_refresca_el_reloj_de_inactividad() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        {
            let mut g = s.0.lock().unwrap();
            g.as_mut().unwrap().ultimo_uso = Instant::now() - INACTIVIDAD + Duration::from_secs(30);
        }
        s.cifrar("a tiempo").unwrap();

        // Si no se refrescara, consultar credenciales seguido acabaría pidiendo
        // la contraseña a mitad de faena.
        let g = s.0.lock().unwrap();
        assert!(g.as_ref().unwrap().ultimo_uso.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn un_bloque_manipulado_no_se_descifra_en_silencio() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        let cifrado = s.cifrar("valor bueno").unwrap();

        // Alguien con acceso al repositorio cambia un carácter del base64.
        let mut roto: Vec<char> = cifrado.chars().collect();
        let i = roto.len() - 2;
        roto[i] = if roto[i] == 'A' { 'B' } else { 'A' };
        let roto: String = roto.into_iter().collect();

        // XChaCha20-Poly1305 está autenticado: falla en vez de devolver basura.
        assert!(s.descifrar(&roto).is_err());
    }

    #[test]
    fn no_se_puede_configurar_dos_veces_ni_con_contrasena_corta() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        assert!(s.configurar(&t.0, "   ").is_err());
        // Se puede atacar sin conexión y no tiene reset: 12 caracteres mínimo.
        assert!(s.configurar(&t.0, "corta123").is_err());
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        // Reconfigurar dejaría ilegibles todos los bloques ya cifrados.
        assert!(s.configurar(&t.0, NUEVA).is_err());
    }

    #[test]
    fn rotar_recifra_todos_los_bloques_y_los_abre_la_clave_nueva() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        let a = s.cifrar("clave-bd").unwrap();
        let b = s.cifrar("token-api").unwrap();
        let doc = nota_con_secretos(&[&a, &b]);

        let cambiadas = s.rotar(&t.0, CLAVE_MAESTRA, NUEVA, &[doc]).unwrap();
        assert_eq!(cambiadas.len(), 1);

        // Los bloques han cambiado de bytes...
        let texto = cambiadas[0].contenido.to_string();
        assert!(!texto.contains(&a) && !texto.contains(&b));
        // ...y siguen guardando lo mismo, ahora bajo la contraseña nueva.
        let otro = Secretos::default();
        otro.desbloquear(&t.0, NUEVA).unwrap();
        let nuevos: Vec<String> = texto
            .split('"')
            .filter(|s| s.starts_with("v1."))
            .map(String::from)
            .collect();
        assert_eq!(nuevos.len(), 2);
        let claros: Vec<String> = nuevos.iter().map(|c| otro.descifrar(c).unwrap()).collect();
        assert!(claros.contains(&"clave-bd".to_string()));
        assert!(claros.contains(&"token-api".to_string()));
    }

    #[test]
    fn tras_rotar_la_contrasena_vieja_ya_no_abre() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        let cifrado = s.cifrar("clave-bd").unwrap();
        s.rotar(&t.0, CLAVE_MAESTRA, NUEVA, &[nota_con_secretos(&[&cifrado, &cifrado])])
            .unwrap();

        // Es lo que busca quien rota porque alguien deja el equipo.
        let ex = Secretos::default();
        assert!(ex.desbloquear(&t.0, CLAVE_MAESTRA).is_err());
        assert!(ex.desbloquear(&t.0, NUEVA).is_ok());
    }

    #[test]
    fn rotar_no_toca_las_notas_sin_secretos() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();

        let sencilla = nota_con_secretos(&[]);

        // Devolverlas todas ensuciaría el diff de git y la fecha de modificación
        // de notas que no han cambiado.
        assert!(s.rotar(&t.0, CLAVE_MAESTRA, NUEVA, &[sencilla]).unwrap().is_empty());
    }

    #[test]
    fn rotar_con_la_contrasena_actual_equivocada_no_toca_nada() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        let cifrado = s.cifrar("clave-bd").unwrap();
        let antes = std::fs::read_to_string(t.0.join(FICHERO)).unwrap();

        assert!(s
            .rotar(&t.0, "no es la buena", NUEVA, &[nota_con_secretos(&[&cifrado, &cifrado])])
            .is_err());

        // Ni la configuración ni la clave en memoria se han movido: si se
        // escribiera antes de comprobar, la bóveda quedaría inservible.
        assert_eq!(std::fs::read_to_string(t.0.join(FICHERO)).unwrap(), antes);
        assert_eq!(s.descifrar(&cifrado).unwrap(), "clave-bd");
    }

    #[test]
    fn si_un_bloque_no_descifra_no_se_escribe_nada() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        let bueno = s.cifrar("clave-bd").unwrap();
        let antes = std::fs::read_to_string(t.0.join(FICHERO)).unwrap();

        // Un bloque corrupto en medio del recorrido.
        let doc = nota_con_secretos(&[&bueno, "v1.basura-que-no-descifra"]);
        assert!(s.rotar(&t.0, CLAVE_MAESTRA, NUEVA, &[doc]).is_err());

        // Lo crítico: la contraseña NO ha cambiado. Si se hubiera escrito la
        // configuración nueva, los bloques ya cifrados quedarían ilegibles para
        // siempre — la bóveda rota sin arreglo.
        assert_eq!(std::fs::read_to_string(t.0.join(FICHERO)).unwrap(), antes);
        assert_eq!(s.descifrar(&bueno).unwrap(), "clave-bd");
    }

    #[test]
    fn rotar_exige_tambien_el_minimo_en_la_nueva() {
        let t = Temporal::nueva();
        let s = Secretos::default();
        s.configurar(&t.0, CLAVE_MAESTRA).unwrap();
        assert!(s.rotar(&t.0, CLAVE_MAESTRA, "corta", &[]).is_err());
    }
}

#[cfg(test)]
mod tests_formato {
    use super::*;

    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp() -> Temp {
        let d = std::env::temp_dir().join(format!("fmt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        Temp(d)
    }

    #[test]
    fn el_fichero_explica_como_descifrarlo() {
        let t = temp();
        Secretos::default().configurar(&t.0, "correcta caballo bateria").unwrap();
        let txt = std::fs::read_to_string(t.0.join(FICHERO)).unwrap();

        // El algoritmo NO es un secreto (toda la seguridad está en la
        // contraseña), y en cambio sin esto tu yo de dentro de tres años se
        // queda mirando un `version: 1` que no dice nada.
        for pista in ["argon2id", "xchacha20poly1305", "19456", "nonce[24]"] {
            assert!(txt.contains(pista), "falta «{pista}» en:\n{txt}");
        }
        // Y lo que no puede estar: nada que ayude a adivinar la contraseña.
        assert!(!txt.contains("correcta caballo"));
    }

    #[test]
    fn una_boveda_anterior_gana_las_anotaciones_al_abrirla() {
        let t = temp();
        let s = Secretos::default();
        s.configurar(&t.0, "correcta caballo bateria").unwrap();
        let cifrado = s.cifrar("secreto").unwrap();

        // Se recorta el fichero al formato antiguo, sin las anotaciones.
        let antiguo: serde_json::Value = serde_json::json!({
            "version": 1,
            "sal": serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(t.0.join(FICHERO)).unwrap()).unwrap()["sal"],
            "verificador": serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(t.0.join(FICHERO)).unwrap()).unwrap()["verificador"],
        });
        std::fs::write(t.0.join(FICHERO), serde_json::to_string_pretty(&antiguo).unwrap()).unwrap();

        // Abrirla la migra sin pedir nada, y sigue descifrando igual.
        let otro = Secretos::default();
        otro.desbloquear(&t.0, "correcta caballo bateria").unwrap();
        assert_eq!(otro.descifrar(&cifrado).unwrap(), "secreto");
        assert!(std::fs::read_to_string(t.0.join(FICHERO)).unwrap().contains("argon2id"));
    }
}
