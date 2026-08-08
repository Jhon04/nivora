import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';

import { setBaseAssets } from './asset-path';

export interface AssetGuardado {
  id: string;
  /** Nombre relativo del fichero (se guarda en el documento: portable). */
  nombre: string;
  /** Ruta absoluta en disco (por si se necesita puntualmente). */
  ruta: string;
  /** Nombre de la miniatura ligera (null si no se generó). */
  preview?: string | null;
}

/** Imagen leída del disco en crudo: bytes en base64 y extensión (sin punto). */
export interface ImagenLeida {
  datos: string;
  ext: string;
}

@Injectable({ providedIn: 'root' })
export class AssetsService {
  /**
   * Fija la carpeta base de assets para resolver los nombres relativos al
   * mostrarlos. Hay que llamarla al iniciar la app **y cada vez que se cambia de
   * bóveda**: cada bóveda tiene su propio `assets/`, así que si esto no se
   * rehace, las imágenes de la bóveda nueva se buscarían en la anterior.
   *
   * La ruta la da Rust (dueño del registro de bóvedas) en vez de componerla
   * aquí: con `appDataDir() + 'Workspace'` solo funcionaría la bóveda original.
   */
  async iniciar(): Promise<void> {
    const boveda = await invoke<{ ruta: string }>('boveda_activa');
    setBaseAssets(await join(boveda.ruta, 'assets'));
  }

  /** Guarda un asset a partir de sus bytes (base64). */
  guardar(datosBase64: string, ext: string): Promise<AssetGuardado> {
    return invoke<AssetGuardado>('guardar_asset', { datosBase64, ext });
  }

  /** Importa un asset leyendo un fichero del disco por su ruta. */
  importarDesdeRuta(ruta: string): Promise<AssetGuardado> {
    return invoke<AssetGuardado>('importar_asset', { ruta });
  }

  /**
   * Importa una imagen para usarla como icono de nota. Rust la reduce a 128 px
   * antes de guardarla: el icono se pinta pequeño, pero sale en la barra lateral
   * de todas las notas a la vez y el webview lo decodifica entero cada vez.
   */
  importarIcono(ruta: string): Promise<AssetGuardado> {
    return invoke<AssetGuardado>('importar_icono', { ruta });
  }

  /** Lee una imagen del disco SIN guardarla (para editarla antes de insertarla). */
  leerImagen(ruta: string): Promise<ImagenLeida> {
    return invoke<ImagenLeida>('leer_imagen', { ruta });
  }
}
