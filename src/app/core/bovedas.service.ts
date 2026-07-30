import { computed, Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

/** Una bóveda: carpeta autónoma con sus notas, sus imágenes y su repositorio. */
export interface Boveda {
  id: string;
  nombre: string;
  ruta: string;
  /**
   * El cuaderno es de otra persona: se ve pero no se toca.
   *
   * Lo decide la **propiedad del repositorio**, no el permiso de GitHub: en un
   * repositorio privado personal todo colaborador puede empujar, así que mirar
   * el permiso dejaría editable un cuaderno ajeno. Tu propio cuaderno en otro
   * equipo sí se edita.
   *
   * Ocultar los controles aquí es solo cortesía: **el veto lo aplica Rust** en
   * cada comando de escritura.
   */
  soloLectura: boolean;
  /**
   * El repositorio de esta bóveda es de tu cuenta. El dueño edita todo y es el
   * único que pone y quita el candado de las notas.
   */
  soyDueno: boolean;
  /**
   * Ya no tienes acceso al repositorio: te han sacado, o lo han borrado o
   * renombrado. La bóveda **no se borra sola** (puede tener notas tuyas, y
   * borrar ficheros porque un tercero pulsó algo en GitHub sería una puerta
   * trasera): deja de sincronizarse y se ofrece quitarla.
   */
  sinAcceso: boolean;
}

/**
 * Bóvedas del equipo y cuál está abierta.
 *
 * OJO al cambiar de bóveda: no basta con llamar a `cambiar()`. Hay que **vaciar
 * el guardado pendiente antes** y **volver a fijar la carpeta de assets
 * después**; además, el documento abierto pertenece a la bóveda anterior y hay
 * que cerrarlo. Todo eso lo orquesta `App.cambiarBoveda()`, que es el único
 * sitio desde el que debería llamarse a este servicio.
 */
@Injectable({ providedIn: 'root' })
export class BovedasService {
  readonly lista = signal<Boveda[]>([]);
  readonly activa = signal<Boveda | null>(null);

  /** ¿La bóveda abierta es de solo lectura entera? */
  readonly soloLectura = computed(() => this.activa()?.soloLectura ?? false);

  /** ¿Mandas tú en la bóveda abierta? */
  readonly soyDueno = computed(() => this.activa()?.soyDueno ?? true);

  /** ¿Se perdió el acceso al repositorio de la bóveda abierta? */
  readonly sinAcceso = computed(() => this.activa()?.sinAcceso ?? false);

  /** Vuelve a preguntar a GitHub si el acceso ha vuelto. */
  async comprobarAcceso(): Promise<boolean> {
    const ok = await invoke<boolean>('comprobar_acceso');
    await this.cargar();
    return ok;
  }

  async cargar(): Promise<void> {
    const [lista, activa] = await Promise.all([
      invoke<Boveda[]>('listar_bovedas'),
      invoke<Boveda>('boveda_activa'),
    ]);
    this.lista.set(lista);
    this.activa.set(activa);
  }

  /** Crea una bóveda vacía y cambia a ella. */
  async crear(nombre: string): Promise<Boveda> {
    const b = await invoke<Boveda>('crear_boveda', { nombre });
    await this.cargar();
    return b;
  }

  async cambiar(id: string): Promise<Boveda> {
    const b = await invoke<Boveda>('cambiar_boveda', { id });
    await this.cargar();
    return b;
  }

  /** Quita la bóveda de la lista. No borra sus ficheros. */
  async olvidar(id: string): Promise<void> {
    await invoke<void>('olvidar_boveda', { id });
    await this.cargar();
  }

  async renombrar(id: string, nombre: string): Promise<Boveda> {
    const b = await invoke<Boveda>('renombrar_boveda', { id, nombre });
    await this.cargar();
    return b;
  }
}
