import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/** Longitud mínima de la contraseña maestra (debe coincidir con `secretos.rs`). */
export const MINIMO_CLAVE = 12;

export interface EstadoSecretos {
  /** ¿Esta bóveda ya tiene contraseña maestra? */
  configurado: boolean;
  /** ¿Está la clave en memoria ahora mismo? */
  desbloqueado: boolean;
}

/**
 * Bloques cifrados dentro de una nota.
 *
 * La **clave nunca llega hasta aquí**: vive en Rust, en memoria y solo un rato.
 * Este servicio manda el texto a cifrar y recibe el cifrado (o al revés), pero
 * no puede derivarla ni guardarla, igual que con el token de GitHub.
 */
@Injectable({ providedIn: 'root' })
export class SecretosService {
  readonly configurado = signal(false);
  readonly desbloqueado = signal(false);

  async cargarEstado(): Promise<EstadoSecretos> {
    const e = await invoke<EstadoSecretos>('estado_secretos');
    this.configurado.set(e.configurado);
    this.desbloqueado.set(e.desbloqueado);
    return e;
  }

  /** Fija la contraseña maestra de la bóveda (solo la primera vez). */
  async configurar(contrasena: string): Promise<void> {
    await invoke<void>('configurar_secretos', { contrasena });
    this.configurado.set(true);
    this.desbloqueado.set(true);
  }

  async desbloquear(contrasena: string): Promise<void> {
    await invoke<void>('desbloquear_secretos', { contrasena });
    this.desbloqueado.set(true);
  }

  async bloquear(): Promise<void> {
    await invoke<void>('bloquear_secretos');
    this.desbloqueado.set(false);
  }

  /**
   * Cambia la contraseña maestra y recifra todos los bloques. Devuelve cuántas
   * notas se han tocado.
   *
   * Sirve para cuando alguien deja el equipo, pero **no le quita lo que ya vio**
   * ni el clon del repositorio que tenga con el cifrado viejo: para eso hay que
   * cambiar las credenciales de verdad.
   */
  rotar(actual: string, nueva: string): Promise<number> {
    return invoke<number>('rotar_clave_maestra', { actual, nueva });
  }

  cifrar(texto: string): Promise<string> {
    return invoke<string>('cifrar_secreto', { texto });
  }

  /**
   * Devuelve el texto en claro. Puede fallar si la clave se cerró por
   * inactividad: quien llame debe estar listo para pedir la contraseña otra vez.
   */
  descifrar(datos: string): Promise<string> {
    return invoke<string>('descifrar_secreto', { datos });
  }
}
