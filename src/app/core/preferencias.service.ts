import { Injectable } from '@angular/core';

/** 'sistema' sigue el ajuste del escritorio (ver TemaService). */
export type Tema = 'sistema' | 'claro' | 'oscuro';

/** Preferencias de interfaz que sobreviven al cierre de la app. */
export interface Preferencias {
  sidebarColapsada: boolean;
  /** Panel del índice (títulos de la nota) a la derecha del documento. */
  indiceAbierto: boolean;
  tema: Tema;
}

const CLAVE = 'nivora.preferencias';

const POR_DEFECTO: Preferencias = {
  sidebarColapsada: false,
  indiceAbierto: true,
  tema: 'sistema',
};

/**
 * Preferencias de UI guardadas en el almacenamiento del webview. Tauri lo
 * conserva en la carpeta de datos de la app (ligada al identificador del
 * bundle), así que persisten entre ejecuciones sin tocar el lado Rust.
 *
 * Los documentos SÍ van por IPC a Rust (ver DocumentosService); aquí solo hay
 * estado de interfaz, que no debe ensuciar el workspace del usuario.
 */
@Injectable({ providedIn: 'root' })
export class PreferenciasService {
  private prefs: Preferencias = this.leer();

  obtener(): Preferencias {
    return this.prefs;
  }

  /** Actualiza una preferencia y la persiste. */
  fijar<K extends keyof Preferencias>(clave: K, valor: Preferencias[K]): void {
    this.prefs = { ...this.prefs, [clave]: valor };
    try {
      localStorage.setItem(CLAVE, JSON.stringify(this.prefs));
    } catch {
      // Sin almacenamiento disponible: la app sigue funcionando, solo se pierde
      // la preferencia al cerrar.
    }
  }

  private leer(): Preferencias {
    try {
      const crudo = localStorage.getItem(CLAVE);
      if (!crudo) return { ...POR_DEFECTO };
      // Fusionamos con los valores por defecto para tolerar preferencias
      // guardadas por versiones anteriores (claves ausentes o de más).
      return { ...POR_DEFECTO, ...(JSON.parse(crudo) as Partial<Preferencias>) };
    } catch {
      return { ...POR_DEFECTO };
    }
  }
}
