import { Injectable, signal } from '@angular/core';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/** En qué punto del proceso estamos, para que la interfaz lo pueda pintar. */
export type EstadoActualizacion =
  | 'inactivo'
  | 'buscando'
  | 'disponible'
  | 'descargando'
  | 'lista'
  | 'error';

/**
 * Actualización automática de la app.
 *
 * El binario se descarga del release de GitHub y **se verifica contra la clave
 * pública** que va compilada dentro de la app (`plugins.updater.pubkey`): si la
 * firma no cuadra, el plugin lo rechaza. Eso es lo que impide que alguien que
 * controle la red sirva un ejecutable suyo.
 *
 * Ojo con el `.deb`: el updater de Tauri solo sabe reemplazar AppImage en Linux,
 * así que quien instale por paquete no verá actualizaciones aquí. Es una
 * limitación del formato, no un fallo — ver README.
 */
@Injectable({ providedIn: 'root' })
export class ActualizacionesService {
  readonly estado = signal<EstadoActualizacion>('inactivo');
  readonly versionNueva = signal<string | null>(null);
  readonly notas = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** Porcentaje descargado (0-100), o null si aún no se sabe el tamaño. */
  readonly progreso = signal<number | null>(null);

  private pendiente: Update | null = null;

  /**
   * Pregunta si hay versión nueva. Devuelve true si la hay.
   *
   * `silencioso` distingue la comprobación del arranque (donde un fallo de red
   * no debe enseñarle nada al usuario) de la que pide él a mano desde Ajustes.
   */
  async comprobar(silencioso = false): Promise<boolean> {
    if (this.estado() === 'buscando' || this.estado() === 'descargando') return false;

    this.estado.set('buscando');
    this.error.set(null);
    try {
      const update = await check();
      if (!update) {
        this.estado.set('inactivo');
        return false;
      }
      this.pendiente = update;
      this.versionNueva.set(update.version);
      this.notas.set(update.body ?? null);
      this.estado.set('disponible');
      return true;
    } catch (e) {
      // Sin red, GitHub caído o un latest.json a medio publicar: la app funciona
      // igual, así que en el arranque esto se traga sin decir nada.
      this.estado.set(silencioso ? 'inactivo' : 'error');
      if (!silencioso) this.error.set(this.msg(e));
      return false;
    }
  }

  /**
   * Descarga e instala la actualización pendiente, y reinicia.
   *
   * No vuelve: si todo va bien, `relaunch()` mata este proceso. Por eso el
   * guardado pendiente hay que vaciarlo ANTES de llamar aquí.
   */
  async instalarYReiniciar(): Promise<void> {
    const update = this.pendiente;
    if (!update) return;

    this.estado.set('descargando');
    this.progreso.set(null);
    this.error.set(null);
    try {
      let total = 0;
      let bajado = 0;
      await update.downloadAndInstall((ev) => {
        switch (ev.event) {
          case 'Started':
            // contentLength puede venir vacío si el servidor no lo manda; en ese
            // caso se deja el progreso en null y la barra va indeterminada.
            total = ev.data.contentLength ?? 0;
            break;
          case 'Progress':
            bajado += ev.data.chunkLength;
            if (total > 0) this.progreso.set(Math.round((bajado / total) * 100));
            break;
          case 'Finished':
            this.progreso.set(100);
            break;
        }
      });
      this.estado.set('lista');
      await relaunch();
    } catch (e) {
      this.estado.set('error');
      this.error.set(this.msg(e));
    }
  }

  /** El usuario dice «ahora no»: se olvida hasta el siguiente arranque. */
  descartar(): void {
    this.pendiente = null;
    this.versionNueva.set(null);
    this.notas.set(null);
    this.estado.set('inactivo');
  }

  private msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
