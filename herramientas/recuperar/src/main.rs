//! Saca los bloques cifrados de una bóveda de Nota Local SIN usar la app.
//!
//!     recuperar <carpeta-de-la-boveda> <contraseña-maestra>
//!
//! Formato, por si algún día hay que reimplementarlo en otro lenguaje:
//!   secretos.json -> { "sal": base64(16 bytes) }
//!   clave         = Argon2id(contraseña, sal, m=19456 KiB, t=2, p=1, 32 bytes)
//!   bloque        = "v1." + base64( nonce[24] || XChaCha20-Poly1305(clave, nonce, claro) )

use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{aead::{Aead, KeyInit}, XChaCha20Poly1305, XNonce};

fn descifrar(clave: &[u8; 32], datos: &str) -> Option<String> {
    let bytes = STANDARD.decode(datos.strip_prefix("v1.")?).ok()?;
    let (nonce, sellado) = bytes.split_at(24);
    let claro = XChaCha20Poly1305::new(clave.into())
        .decrypt(XNonce::from_slice(nonce), sellado)
        .ok()?;
    String::from_utf8(claro).ok()
}

/// Recorre el JSON de la nota buscando nodos `secreto` a cualquier profundidad.
fn recorrer(v: &serde_json::Value, clave: &[u8; 32], salida: &mut Vec<(String, String)>) {
    match v {
        serde_json::Value::Object(m) => {
            if m.get("type").and_then(|t| t.as_str()) == Some("secreto") {
                if let Some(a) = m.get("attrs") {
                    let etiqueta = a.get("etiqueta").and_then(|e| e.as_str()).unwrap_or("");
                    if let Some(d) = a.get("datos").and_then(|d| d.as_str()) {
                        let claro = descifrar(clave, d)
                            .unwrap_or_else(|| "<no se pudo descifrar>".into());
                        salida.push((etiqueta.to_string(), claro));
                    }
                }
            }
            m.values().for_each(|x| recorrer(x, clave, salida));
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| recorrer(x, clave, salida)),
        _ => {}
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (boveda, contrasena) = (&args[1], &args[2]);

    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{boveda}/secretos.json")).unwrap())
            .unwrap();
    let sal = STANDARD.decode(config["sal"].as_str().unwrap()).unwrap();

    let mut clave = [0u8; 32];
    Argon2::default()
        .hash_password_into(contrasena.as_bytes(), &sal, &mut clave)
        .unwrap();

    // El verificador dice si la contraseña es la buena antes de tocar las notas.
    match descifrar(&clave, config["verificador"].as_str().unwrap()) {
        Some(t) if t == "nota-local::secretos" => println!("contraseña correcta\n"),
        _ => { eprintln!("contraseña incorrecta"); std::process::exit(1); }
    }

    for e in std::fs::read_dir(format!("{boveda}/notas")).unwrap().flatten() {
        let txt = std::fs::read_to_string(e.path()).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&txt).unwrap();
        let mut secretos = Vec::new();
        recorrer(&doc, &clave, &mut secretos);
        if secretos.is_empty() { continue; }
        println!("{}", doc["titulo"].as_str().unwrap_or("(sin título)"));
        for (etiqueta, claro) in secretos {
            println!("  {etiqueta:<22} {claro}");
        }
    }
}
