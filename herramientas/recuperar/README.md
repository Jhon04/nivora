# recuperar

Saca los bloques cifrados de una bóveda de Nivora **sin usar la app**.

```bash
cargo run -- ~/.local/share/pe.pluton.nivora/Workspace "tu contraseña maestra"
```

```
contraseña correcta

Credenciales de ADCOMP
  BD de producción       jdbc:mysql://localhost:3307/adcomp
  Usuario                pedroRamires
```

## Para qué está

Para que tus credenciales no queden secuestradas por la app. Si un día no
compila, la abandonas o te cambias de herramienta, esto las recupera.

No depende de nada del proyecto: solo de `argon2`, `chacha20poly1305`, `base64`
y `serde_json`, que son librerías públicas. Son ~60 líneas a propósito, para que
se puedan leer enteras y reimplementar en cualquier lenguaje.

## El formato

Lo mismo está anotado dentro de cada `secretos.json`, por si algún día llegas a
él sin este README:

```
secretos.json → { "sal": base64(16 bytes), "kdf": "argon2id", … }

clave  = Argon2id(contraseña, sal, m=19456 KiB, t=2, p=1, salida=32 bytes)
bloque = "v1." + base64( nonce[24] || XChaCha20-Poly1305(clave, nonce, claro) )
```

El `verificador` es el texto `nivora::secretos` cifrado con esa clave: sirve
para saber si la contraseña es correcta antes de tocar las notas.

## Por qué esto no debilita nada

El algoritmo no es —ni debe ser— un secreto: toda la seguridad está en la
contraseña. Ocultarlo sería inútil (basta un `strings` sobre el binario) y
además dejaría tus datos irrecuperables el día que hiciera falta.

Lo que hace inviable probar contraseñas a lo bruto es Argon2id: cada intento
cuesta ~50-100 ms **y 19 MiB de RAM**. Con una frase de varias palabras, un
ataque por diccionario no llega a ningún sitio.
